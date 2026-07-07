const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { Resend } = require('resend');
require('dotenv').config();
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client(process.env.GOOGLE_WEB_CLIENT_ID);
const cheerio = require('cheerio');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'] }));
app.use(express.json({ limit: '20mb' }));

// ─── SECURITY: Validate API key on protected routes ──────────
function requireApiKey(req, res, next) {
  var validKey = process.env.API_SECRET_KEY;
  if (!validKey) {
    console.error('FATAL: API_SECRET_KEY env var not set — refusing all authenticated requests');
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  var key = req.headers['x-api-key'] || req.headers['authorization'];
  if (!key || key.replace('Bearer ', '') !== validKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── SECURITY: Issue a signed session token at login ─────────
// user_id (the DB row's actual id, NOT derived from email) is embedded as a
// claim inside a token only this server can sign and verify. A client can
// no longer just assert "I am user X" — they must present a token this
// server itself issued after real authentication (OTP or Google).
function issueToken(user) {
  return jwt.sign(
    { sub: user.id, google_id: user.google_id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// ─── SECURITY: Verify session token — replaces the old requireUser, which
// only checked that a CLIENT-SUPPLIED user_id existed in the DB (no proof
// of ownership at all). This middleware instead cryptographically verifies
// the token and takes the identity FROM the token, never from req.body.
async function requireUser(req, res, next) {
  if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET env var not set — refusing all authenticated requests');
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  var authHeader = req.headers['authorization'] || '';
  var token = authHeader.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    var decoded = jwt.verify(token, process.env.JWT_SECRET);
    var result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.sub]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'User not found' });
    req.user = result.rows[0]; // identity is now server-verified, not client-asserted
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: {
    temperature: 0.5,
    topP: 0.9,
    maxOutputTokens: 8192,
  },
});
// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Initialize PostgreSQL
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Create OTP table if not exists
pool.query(`
  CREATE TABLE IF NOT EXISTS otp_codes (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
  )
`).then(function() {
  console.log('OTP table ready');
}).catch(function(err) { console.error('OTP table create error:', err.message); });

// Create users table if not exists — uses google_id to match existing schema
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    name TEXT,
    email TEXT UNIQUE,
    is_pro BOOLEAN DEFAULT FALSE,
    proposal_count INTEGER DEFAULT 0,
    photo_url TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )
`).then(function() {
  console.log('Users table ready');
  // Add photo_url column if upgrading from an older schema that didn't have it
  return pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT`);
}).catch(function(err) { console.error('Users table create error:', err.message); });

// Tracks emails that have already used a free trial, even after the user
// account row itself is deleted, so deleting + re-signing up with the same
// email cannot grant a second free trial.
pool.query(`
  CREATE TABLE IF NOT EXISTS used_emails (
    email TEXT PRIMARY KEY,
    first_seen_at TIMESTAMP DEFAULT NOW()
  )
`).then(function() {
  console.log('Used emails table ready');
}).catch(function(err) { console.error('Used emails table create error:', err.message); });

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many requests. Please wait a minute.' },
});
app.use('/generate', limiter);

// OTP rate limiter - max 5 sends per 10 minutes per IP
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { error: 'Too many OTP requests. Please wait 10 minutes.' },
});

// OTP verify limiter - max 10 verification attempts per 10 minutes per IP,
// to prevent brute-forcing the 6-digit code within its expiry window.
const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Please request a new code and wait 10 minutes.' },
});


// ─── PARSE PROFILE WITH GEMINI ───────────────────────────────────────────────
// Receives raw Upwork NUXT profile data, sends to Gemini, returns structured JSON
app.post('/parse-profile', requireApiKey, async function(req, res) {
  var rawData = req.body.rawData;
  if (!rawData) return res.status(400).json({ error: 'rawData required' });

  try {
    var prompt = `Extract structured freelancer profile data from this Upwork profile JSON.

Return ONLY valid JSON in this EXACT structure (no markdown, no backticks, no explanation):
{
  "name": "full name or empty string",
  "title": "professional title or empty string",
  "bio": "professional bio/description or empty string",
  "skills": ["skill1", "skill2"],
  "rate": "hourly rate as number string e.g. 35 or empty string",
  "location": "city or country or empty string",
  "jobSuccess": "job success score e.g. 91% or empty string",
  "totalJobs": "total completed jobs number or empty string",
  "totalHours": "total hours number or empty string",
  "yearsExperience": "estimated years from work history dates or empty string",
  "employmentHistory": [{"title": "job title", "company": "company", "duration": "dates"}],
  "completedProjects": [{"title": "project title", "description": "brief description", "result": "outcome"}]
}

Rules:
- Extract ONLY what is explicitly present in the data. Never invent values.
- For yearsExperience: calculate from earliest employment date to now. Empty string if not determinable.
- Keep completedProjects to max 5 most relevant.
- Skills array max 15 items.

Data:
${rawData.substring(0, 15000)}`;

    var result = await model.generateContent(prompt);
    var text = result.response.text().trim();
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    var parsed = JSON.parse(text);
    console.log('/parse-profile success for:', parsed.name || 'unknown');
    return res.json({ success: true, profile: parsed });
  } catch (error) {
    console.error('/parse-profile error:', error.message);
    return res.status(500).json({ error: 'Could not parse profile. Please fill in manually.' });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({
    status: 'Amalite backend is running',
    version: '10.0',
  });
});

// ─── GENERATE ─────────────────────────────────────────────────────────────────
app.post('/generate', requireApiKey, requireUser, async function(req, res) {
  var system = req.body.system || '';
  var message = req.body.message;
  var user = req.user; // server-verified identity from the JWT — not from req.body

  if (!message) return res.status(400).json({ error: 'message required' });

  // Input length limit
  if (message.length > 20000) return res.status(400).json({ error: 'Job description too long' });

  // Server-side proposal count enforcement — no longer bypassable by omitting
  // a field, since requireUser already rejected the request if identity
  // couldn't be verified.
  var FREE_LIMIT = 5; // 5 free proposals server-side — standard limit for all users
  if (!user.is_pro && user.proposal_count >= FREE_LIMIT) {
    return res.status(403).json({ error: 'Free proposal limit reached. Please upgrade to Pro.' });
  }
  try {
    await pool.query('UPDATE users SET proposal_count = proposal_count + 1 WHERE id = $1', [user.id]);
  } catch (e) {
    console.error('Proposal count increment error:', e.message);
  }

  try {
    const fullPrompt = system + '\n\n' + message;
    const result = await model.generateContent(fullPrompt);
    res.json({ content: result.response.text() });
  } catch (error) {
    console.error('/generate error:', error.message);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// ─── AUTH: SEND OTP ───────────────────────────────────────────────────────────
app.post('/auth/send-otp', otpLimiter, async function(req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  var name = (req.body.name || '').trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  // Generate 6-digit code
  var code = crypto.randomInt(100000, 999999).toString();
  var expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  try {
    // Delete any existing OTPs for this email
    await pool.query('DELETE FROM otp_codes WHERE email = $1', [email]);

    // Store new OTP
    await pool.query(
      'INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)',
      [email, code, expiresAt]
    );

    console.log('OTP generated for email ending in:', email.slice(-10));

    // Send email via Resend
    var fromAddress = 'Amalite <' + (process.env.FROM_EMAIL || 'noreply@amalite.org') + '>';
    await resend.emails.send({
      from: fromAddress,
      to: email,
      subject: 'Your Amalite verification code',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0A0A18; color: #FAFAFA; border-radius: 12px;">
          <h2 style="color: #2DD4BF; margin-bottom: 8px;">Amalite</h2>
          <p style="color: #9CA3AF; margin-bottom: 24px;">Freelancer Bid Intelligence</p>
          <p style="margin-bottom: 16px;">Hi ${name || 'there'},</p>
          <p style="margin-bottom: 24px;">Your verification code is:</p>
          <div style="background: #1A1A2E; border: 1px solid #2DD4BF; border-radius: 8px; padding: 24px; text-align: center; margin-bottom: 24px;">
            <span style="font-size: 36px; font-weight: 900; letter-spacing: 12px; color: #2DD4BF;">${code}</span>
          </div>
          <p style="color: #9CA3AF; font-size: 13px;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
        </div>
      `,
    });

    res.json({ success: true, message: 'OTP sent to ' + email });
  } catch (error) {
    console.error('/auth/send-otp error:', error.message);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// ─── AUTH: VERIFY OTP ─────────────────────────────────────────────────────────
app.post('/auth/verify-otp', otpVerifyLimiter, async function(req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  var code = (req.body.code || '').trim();
  var name = (req.body.name || '').trim();

  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code required' });
  }

  console.log('OTP verification attempt for email ending in:', email.slice(-10));

  try {
    // Find valid OTP
    var result = await pool.query(
      'SELECT * FROM otp_codes WHERE email = $1 AND code = $2 AND used = FALSE AND expires_at > NOW()',
      [email, code]
    );

    console.log('OTP rows found:', result.rows.length);

    if (result.rows.length === 0) {
      // Debug: check if code exists at all
      var debugResult = await pool.query(
        'SELECT code, used, expires_at FROM otp_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1',
        [email]
      );
      console.log('No matching OTP found for this attempt');
      return res.status(400).json({ error: 'Invalid or expired code. Please request a new one.' });
    }

    // Mark OTP as used
    await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [result.rows[0].id]);

    // Check if this email has used a free trial before (even if that account was deleted)
    var priorUseResult = await pool.query('SELECT email FROM used_emails WHERE email = $1', [email]);
    var hasUsedTrialBefore = priorUseResult.rows.length > 0;

    // Create or find user using google_id column
    var userId = email.replace(/[^a-z0-9]/g, '_') + '_amalite';
    await pool.query(
      `INSERT INTO users (google_id, name, email, proposal_count) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name`,
      [userId, name, email, hasUsedTrialBefore ? 5 : 0]
    );

    // Record this email as having used a trial, so future re-signups (after deletion) can't reset it
    await pool.query(
      'INSERT INTO used_emails (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
      [email]
    );

    // Get user
    var userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    var user = userResult.rows[0];

    res.json({
      success: true,
      token: issueToken(user), // signed session token — client must send this as Authorization: Bearer <token> on every protected request
      user_id: user.google_id,
      name: user.name,
      email: user.email,
      is_pro: user.is_pro,
    });
  } catch (error) {
    console.error('/auth/verify-otp error:', error.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ─── AUTH: GOOGLE SIGN-IN ──────────────────────────────────────────────────────
app.post('/auth/google', async function(req, res) {
  var idToken = req.body.id_token;
  if (!idToken) return res.status(400).json({ error: 'id_token required' });

  try {
    // Server-side verification of the ID token — this is the step that actually
    // proves the token is real and was issued by Google for OUR app, not
    // something a client could fake by just sending arbitrary name/email fields.
    var ticket = await googleClient.verifyIdToken({
      idToken: idToken,
      audience: process.env.GOOGLE_WEB_CLIENT_ID,
    });
    var payload = ticket.getPayload();
    var email = (payload.email || '').trim().toLowerCase();
    var name = payload.name || 'User';
    var photo = payload.picture || '';

    if (!email) return res.status(400).json({ error: 'Google account has no email' });

    // Check prior free-trial use, same logic as OTP signup
    var priorUseResult = await pool.query('SELECT email FROM used_emails WHERE email = $1', [email]);
    var hasUsedTrialBefore = priorUseResult.rows.length > 0;

    var userId = email.replace(/[^a-z0-9]/g, '_') + '_amalite';
    await pool.query(
      `INSERT INTO users (google_id, name, email, photo_url, proposal_count) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, photo_url = EXCLUDED.photo_url`,
      [userId, name, email, photo, hasUsedTrialBefore ? 5 : 0]
    );

    await pool.query(
      'INSERT INTO used_emails (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
      [email]
    );

    var userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    var user = userResult.rows[0];

    res.json({
      success: true,
      token: issueToken(user),
      user_id: user.google_id,
      name: user.name,
      email: user.email,
      is_pro: user.is_pro,
      photo: user.photo_url || '',
    });
  } catch (error) {
    console.error('/auth/google error:', error.message);
    res.status(401).json({ error: 'Google sign-in verification failed' });
  }
});

// ─── RAZORPAY: CREATE ORDER ───────────────────────────────────────────────────
// International card payments approved by Razorpay — processes natively in USD.
app.post('/payment/create-order', requireUser, async function(req, res) {
  try {
    var order = await razorpay.orders.create({
      amount: 499,
      currency: 'USD',
      receipt: 'amalite_pro_' + Date.now(),
      notes: { google_id: req.user.google_id, plan: 'pro_monthly' },
    });
    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('/payment/create-order error:', error.message); res.status(500).json({ error: 'Could not create payment order' });
  }
});

// ─── RAZORPAY: VERIFY PAYMENT ────────────────────────────────────────────────
app.post('/payment/verify', requireUser, async function(req, res) {
  var order_id = req.body.order_id;
  var payment_id = req.body.payment_id;
  var signature = req.body.signature;
  var user = req.user; // server-verified identity — Pro can only ever be granted to whoever authenticated this request

  try {
    var body = order_id + '|' + payment_id;
    var expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature === signature) {
      await pool.query('UPDATE users SET is_pro = TRUE WHERE id = $1', [user.id]);
      console.log('Pro activated for user id:', user.id, 'payment:', payment_id);
      res.json({ success: true, is_pro: true, payment_id: payment_id });
    } else {
      console.error('Invalid payment signature attempt for order:', order_id);
      res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// ─── UPWORK PROFILE IMPORT ─────────────────────────────────────────────────
app.post('/import-profile', requireApiKey, async function(req, res) {
  var url = (req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Upwork profile URL required' });
  if (!url.startsWith('http')) url = 'https://' + url;
  if (!/^https:\/\/(www\.)?upwork\.com\/freelancers\//i.test(url)) {
    return res.status(400).json({ error: 'Please provide a valid Upwork freelancer profile URL' });
  }

  try {
    console.log('Importing Upwork profile via ScraperAPI:', url);

    var scraperKey = process.env.SCRAPER_API_KEY || '';
    if (!scraperKey) {
      return res.status(500).json({ error: 'Import service not configured. Please contact support.' });
    }

    // render=true loads JavaScript so skills/portfolio sections actually appear in the HTML
    var scraperUrl = 'https://api.scraperapi.com/?api_key=' + scraperKey
      + '&url=' + encodeURIComponent(url)
      + '&render=true'
      + '&country_code=us'
      + '&wait_for_selector=' + encodeURIComponent('[data-qa="freelancer-info"], .up-profile-header, body');

    var response = null;
    var lastStatus = 0;
    for (var attempt = 1; attempt <= 2; attempt++) {
      try {
        response = await fetch(scraperUrl, { method: 'GET' });
        lastStatus = response.status;
        if (response.ok) break;
        console.log('ScraperAPI attempt', attempt, 'failed with status', lastStatus);
      } catch (fetchErr) {
        console.log('ScraperAPI attempt', attempt, 'threw:', fetchErr.message);
        lastStatus = 0;
      }
      if (attempt < 2) {
        await new Promise(function(r) { setTimeout(r, 1500); });
      }
    }

    if (!response || !response.ok) {
      console.log('ScraperAPI fetch failed after retries:', lastStatus);
      return res.status(400).json({ error: 'Could not access Upwork profile (status ' + lastStatus + '). Please try again shortly, or fill in your profile manually.' });
    }

    var html = await response.text();
    var $ = cheerio.load(html);

    if (html.length < 500) {
      console.log('ScraperAPI returned suspiciously short content, length:', html.length);
      return res.status(400).json({ error: 'Could not load full profile content. Please try again, or fill in manually.' });
    }

    var profileData = {
      name: '', title: '', location: '', rate: '',
      bio: '', skills: [], jobSuccess: '',
    };

    // PRIMARY STRATEGY: Upwork embeds profile data server-side inside a minified
    // window.__NUXT__ JS payload (not clean JSON, not plain HTML attributes).
    // CSS-selector scraping fails here because class names are hashed/obfuscated
    // (e.g. data-v-3dee3f5a) and the real data lives in that giant script tag.
    // So we extract directly from known reliable signals instead:

    // og:title / og:description meta tags are reliably populated server-side
    var ogTitle = $('meta[property="og:title"]').attr('content') || '';
    if (ogTitle) {
      profileData.name = ogTitle.trim();
    }
    var ogDesc = $('meta[property="og:description"]').attr('content') || '';
    if (ogDesc) {
      // og:description is usually "Workflow Automation Expert | Excel VBA..."
      profileData.title = ogDesc.replace(/^View .*? profile on Upwork.*$/i, '').trim();
    }
    // The <title> tag reliably contains "Name - Title - Upwork Freelancer from City, Country"
    var pageTitle = $('title').first().text() || '';
    var titleParts = pageTitle.split(' - ');
    if (titleParts.length >= 3) {
      if (!profileData.name) profileData.name = titleParts[0].trim();
      if (!profileData.title) profileData.title = titleParts[1].trim();
      var fromMatch = pageTitle.match(/Upwork Freelancer from (.+)$/i);
      if (fromMatch) profileData.location = fromMatch[1].trim();
    }

    // Extract from JSON-LD if present
    $('script[type="application/ld+json"]').each(function() {
      try {
        var ld = JSON.parse($(this).html());
        if (ld.description && !profileData.bio) profileData.bio = ld.description;
        if (ld.jobTitle && !profileData.title) profileData.title = ld.jobTitle;
      } catch(e) {}
    });

    // Extract structured data straight out of the __NUXT__ payload using targeted
    // regex on known field labels, since it's a JS function call, not valid JSON
    var nameMatch = html.match(/name:"([^"]{2,60})",firstName:/);
    if (nameMatch) profileData.name = nameMatch[1];

    var titleMatch = html.match(/firstName:"[^"]*",shortName:[^,]+,title:"([^"]{2,200})"/);
    if (titleMatch) profileData.title = titleMatch[1];

    var descMatch = html.match(/description:"((?:[^"\\]|\\.){10,1000})",location:/);
    if (descMatch) {
      try { profileData.bio = JSON.parse('"' + descMatch[1] + '"'); } catch(e) { profileData.bio = descMatch[1]; }
    }

    var cityMatch = html.match(/country:"([^"]+)",city:"([^"]+)"/);
    if (cityMatch) profileData.location = cityMatch[2] + ', ' + cityMatch[1];

    var rateMatch = html.match(/hourlyRate:\{currencyCode:"USD",amount:([\d.]+)\}/);
    if (rateMatch) profileData.rate = rateMatch[1];

    // Job Success score: the rendered badge text "91%" + "Job Success" label is unambiguous.
    // (nSS100BwScore is an internal decimal score, not reliably the same as the displayed %.)
    var jssAlt = html.match(/(\d{1,3})%\s*<\/span>\s*<span[^>]*>\s*Job Success/i);
    if (jssAlt) profileData.jobSuccess = jssAlt[1] + '%';

    // Skills appear as prettyName:"X" pairs scattered through the skills array
    var skillMatches = html.match(/prettyName:"([^"]{2,40})"/g);
    if (skillMatches) {
      skillMatches.forEach(function(m) {
        var name = m.match(/prettyName:"([^"]+)"/)[1];
        if (name && !profileData.skills.includes(name) && profileData.skills.length < 30) {
          profileData.skills.push(name);
        }
      });
    }

    // Work history — extract from __NUXT__ payload "title:" fields inside assignment objects.
    // These appear as: title:"Some Job Title",description:"..."
    profileData.workHistory = [];
    var workHistoryRegex = /startedOn:"[^"]+",endedOn:[^,]+,totalHours:[^,]+,type:[^,]+,title:"((?:[^"\\]|\\.){3,150})",description:"((?:[^"\\]|\\.){0,400})"/g;
    var whMatch;
    while ((whMatch = workHistoryRegex.exec(html)) !== null && profileData.workHistory.length < 10) {
      try {
        var whTitle = JSON.parse('"' + whMatch[1] + '"');
        var whDesc = JSON.parse('"' + whMatch[2] + '"').slice(0, 300);
        if (whTitle) profileData.workHistory.push({ title: whTitle, description: whDesc });
      } catch(e) {}
    }

    // Portfolio items — title fields inside the portfolios array (uid/title pairs)
    profileData.portfolio = [];
    var portfolioRegex = /title:aC[,}]|title:"((?:[^"\\]|\\.){3,150})",description:aD/;
    // Fallback: look for explicit portfolio title near "thumbnail" field
    var portfolioRegex2 = /title:"((?:[^"\\]|\\.){3,150})",description:(?:"(?:[^"\\]|\\.){0,400}"|a[A-Z]),thumbnail:/g;
    var pMatch;
    while ((pMatch = portfolioRegex2.exec(html)) !== null && profileData.portfolio.length < 10) {
      try {
        var pTitle = JSON.parse('"' + pMatch[1] + '"');
        if (pTitle && !profileData.portfolio.includes(pTitle)) profileData.portfolio.push(pTitle);
      } catch(e) {}
    }

    // Education / employment history not reliably present for this profile type; leave empty
    profileData.education = [];

    // Total jobs / total hours — present as plain stats fields
    var totalJobsMatch = html.match(/totalJobsWorked:(\d+)/);
    if (totalJobsMatch) profileData.totalJobs = totalJobsMatch[1];
    var totalHoursMatch = html.match(/totalHours:([\d.]+),totalHoursRecent/);
    if (totalHoursMatch) profileData.totalHours = totalHoursMatch[1];

    // Clean up bio
    if (profileData.bio && profileData.bio.length > 500) {
      profileData.bio = profileData.bio.substring(0, 500);
    }

    if (!profileData.name && !profileData.title && !profileData.bio && profileData.skills.length === 0) {
      return res.status(400).json({
        error: 'Could not extract profile data. The page may not have loaded fully. Try again or enter your details manually.',
        partial: profileData
      });
    }

    console.log('Profile imported:', profileData.name, '|', profileData.title, '| skills:', profileData.skills.length, '| workHistory:', profileData.workHistory.length);
    res.json({ success: true, profile: profileData });

  } catch (error) {
    console.error('/import-profile error:', error.message);
    res.status(500).json({ error: 'Import failed. Please try again or fill in your profile manually.' });
  }
});


// ─── GET USER PRO STATUS ──────────────────────────────────────────────────────
app.post('/user/status', requireUser, async function(req, res) {
  // req.user is already the full row, fetched by requireUser via the verified token
  res.json({
    is_pro: req.user.is_pro,
    proposal_count: req.user.proposal_count,
    photo: req.user.photo_url || '',
  });
});

// ─── DELETE USER ACCOUNT ──────────────────────────────────────────────────────
app.post('/user/delete', requireUser, async function(req, res) {
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    // Note: row in used_emails is intentionally NOT removed — it permanently
    // blocks this email from getting a second free trial after re-signup.
    res.json({ success: true });
  } catch(e) {
    console.error('/user/delete error:', e.message);
    res.status(500).json({ error: 'Account deletion failed' });
  }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Amalite backend v10.0 running on port ' + PORT);
});