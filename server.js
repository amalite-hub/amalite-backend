const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { Resend } = require('resend');
require('dotenv').config();
const cheerio = require('cheerio');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '20mb' }));

// ─── SECURITY: Validate API key on protected routes ──────────
function requireApiKey(req, res, next) {
  var key = req.headers['x-api-key'] || req.headers['authorization'];
  var validKey = process.env.API_SECRET_KEY || 'amalite-dev-key-2026';
  if (!key || key.replace('Bearer ', '') !== validKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── SECURITY: Validate user session ─────────────────────────
async function requireUser(req, res, next) {
  var userId = req.body.user_id || req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'User ID required' });
  try {
    var result = await pool.query('SELECT * FROM users WHERE google_id = $1', [userId]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'User not found' });
    req.user = result.rows[0];
    next();
  } catch(e) {
    res.status(500).json({ error: 'Auth check failed' });
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
    created_at TIMESTAMP DEFAULT NOW()
  )
`).then(function() {
  console.log('Users table ready');
}).catch(function(err) { console.error('Users table create error:', err.message); });

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

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({
    status: 'Amalite backend is running',
    version: '8.2 (OTP Auth + Gemini)',
    model: 'gemini-2.5-flash',
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    hasRazorpay: !!process.env.RAZORPAY_KEY_ID,
    hasResend: !!process.env.RESEND_API_KEY,
  });
});

// ─── GENERATE ─────────────────────────────────────────────────────────────────
app.post('/generate', requireApiKey, async function(req, res) {
  var system = req.body.system || '';
  var message = req.body.message;
  var userId = req.body.user_id || '';

  if (!message) return res.status(400).json({ error: 'message required' });

  // Input length limit
  if (message.length > 20000) return res.status(400).json({ error: 'Job description too long' });

  // Server-side proposal count enforcement
  if (userId) {
    try {
      var userResult = await pool.query('SELECT * FROM users WHERE google_id = $1', [userId]);
      if (userResult.rows.length > 0) {
        var user = userResult.rows[0];
        var FREE_LIMIT = 100; // 100 free proposals server-side
        if (!user.is_pro && user.proposal_count >= FREE_LIMIT) {
          return res.status(403).json({ error: 'Free proposal limit reached. Please upgrade to Pro.' });
        }
        // Increment proposal count
        await pool.query('UPDATE users SET proposal_count = proposal_count + 1 WHERE google_id = $1', [userId]);
      }
    } catch(e) {
      console.error('Proposal count check error:', e.message);
    }
  }

  try {
    const fullPrompt = system + '\n\n' + message;
    const result = await model.generateContent(fullPrompt);
    res.json({ content: result.response.text() });
  } catch (error) {
    console.error('/generate error:', error.message);
    res.status(500).json({ error: 'AI generation failed', detail: error.message });
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
  var code = Math.floor(100000 + Math.random() * 900000).toString();
  var expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  try {
    // Delete any existing OTPs for this email
    await pool.query('DELETE FROM otp_codes WHERE email = $1', [email]);

    // Store new OTP
    await pool.query(
      'INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)',
      [email, code, expiresAt]
    );

    console.log('OTP stored for', email, '- code:', code);

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
    res.status(500).json({ error: 'Failed to send OTP', detail: error.message });
  }
});

// ─── AUTH: VERIFY OTP ─────────────────────────────────────────────────────────
app.post('/auth/verify-otp', async function(req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  var code = (req.body.code || '').trim();
  var name = (req.body.name || '').trim();

  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code required' });
  }

  console.log('Verifying OTP for', email, 'code:', code);

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
      console.log('Latest OTP for email:', JSON.stringify(debugResult.rows));
      return res.status(400).json({ error: 'Invalid or expired code. Please request a new one.' });
    }

    // Mark OTP as used
    await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [result.rows[0].id]);

    // Create or find user using google_id column
    var userId = email.replace(/[^a-z0-9]/g, '_') + '_amalite';
    await pool.query(
      `INSERT INTO users (google_id, name, email) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name`,
      [userId, name, email]
    );

    // Get user
    var userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    var user = userResult.rows[0];

    res.json({
      success: true,
      user_id: user.google_id,
      name: user.name,
      email: user.email,
      is_pro: user.is_pro,
    });
  } catch (error) {
    console.error('/auth/verify-otp error:', error.message);
    res.status(500).json({ error: 'Verification failed', detail: error.message });
  }
});

// ─── RAZORPAY: CREATE ORDER ───────────────────────────────────────────────────
app.post('/payment/create-order', async function(req, res) {
  try {
    var order = await razorpay.orders.create({
      amount: 499,
      currency: 'USD',
      receipt: 'amalite_pro_' + Date.now(),
      notes: { google_id: req.body.google_id || 'guest', plan: 'pro_monthly' },
    });
    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not create payment order', detail: error.message });
  }
});

// ─── RAZORPAY: VERIFY PAYMENT ────────────────────────────────────────────────
app.post('/payment/verify', async function(req, res) {
  var order_id = req.body.order_id;
  var payment_id = req.body.payment_id;
  var signature = req.body.signature;
  var user_id = req.body.user_id || '';

  try {
    var body = order_id + '|' + payment_id;
    var expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature === signature) {
      if (user_id) {
        // Verify user exists in DB before granting Pro
        var userCheck = await pool.query('SELECT id FROM users WHERE google_id = $1', [user_id]);
        if (userCheck.rows.length === 0) {
          return res.status(400).json({ success: false, error: 'Invalid user' });
        }
        await pool.query('UPDATE users SET is_pro = TRUE WHERE google_id = $1', [user_id]);
        console.log('Pro activated for user:', user_id, 'payment:', payment_id);
      }
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
app.post('/import-profile', async function(req, res) {
  var url = (req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Upwork profile URL required' });
  if (!url.startsWith('http')) url = 'https://' + url;
  if (!url.includes('upwork.com')) return res.status(400).json({ error: 'Please provide a valid Upwork profile URL' });

  try {
    var response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) return res.status(400).json({ error: 'Could not access Upwork profile. Status: ' + response.status });

    var html = await response.text();
    var $ = cheerio.load(html);
    var profileData = { name: '', title: '', location: '', rate: '', bio: '', skills: [], jobSuccess: '' };

    // Try JSON-LD
    $('script[type="application/ld+json"]').each(function() {
      try {
        var ld = JSON.parse($(this).html());
        if (ld.name) profileData.name = profileData.name || ld.name;
        if (ld.description) profileData.bio = profileData.bio || ld.description;
        if (ld.jobTitle) profileData.title = profileData.title || ld.jobTitle;
        if (ld.address) {
          var loc = ld.address.addressLocality || '';
          var country = ld.address.addressCountry || '';
          if (typeof country === 'object') country = country.name || '';
          profileData.location = profileData.location || [loc, country].filter(Boolean).join(', ');
        }
        if (ld.makesOffer && ld.makesOffer.priceSpecification) {
          profileData.rate = profileData.rate || String(ld.makesOffer.priceSpecification.price || '');
        }
      } catch(e) {}
    });

    // Try meta tags
    if (!profileData.name) {
      var ogTitle = $('meta[property="og:title"]').attr('content') || '';
      var parts = ogTitle.split(' - ');
      if (parts.length >= 1) profileData.name = parts[0].trim().replace(/\|.*/, '').trim();
      if (parts.length >= 2) profileData.title = profileData.title || parts[1].replace(/\|.*/, '').trim();
    }
    if (!profileData.bio) {
      profileData.bio = $('meta[property="og:description"]').attr('content') || '';
    }

    // Skills
    $('[data-qa="skill-tag"], .o-tag, .up-skill-badge, .air3-badge').each(function() {
      var skill = $(this).text().trim();
      if (skill && skill.length < 60 && !profileData.skills.includes(skill)) {
        profileData.skills.push(skill);
      }
    });

    // Job success
    var jsMatch = html.match(/jobSuccessScore['"\s:]+([\d]+)/i);
    if (jsMatch) profileData.jobSuccess = jsMatch[1] + '%';

    if (!profileData.name && !profileData.title && !profileData.bio) {
      return res.status(400).json({ error: 'Could not extract profile data. Make sure your Upwork profile is public.' });
    }

    if (profileData.bio && profileData.bio.length > 500) profileData.bio = profileData.bio.slice(0, 500);
    console.log('Profile imported:', profileData.name, '|', profileData.title);
    res.json({ success: true, profile: profileData });
  } catch (error) {
    console.error('/import-profile error:', error.message);
    res.status(500).json({ error: 'Import failed: ' + error.message });
  }
});

// ─── GET USER PRO STATUS ──────────────────────────────────────────────────────
app.post('/user/status', requireApiKey, async function(req, res) {
  var userId = req.body.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id required' });
  try {
    var result = await pool.query('SELECT is_pro, proposal_count FROM users WHERE google_id = $1', [userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ is_pro: result.rows[0].is_pro, proposal_count: result.rows[0].proposal_count });
  } catch(e) {
    res.status(500).json({ error: 'Status check failed' });
  }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Amalite backend v8.2 running on port ' + PORT);
});