const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '20mb' }));

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

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
`).catch(function(err) { console.error('OTP table create error:', err.message); });

// Create users table if not exists
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    name TEXT,
    email TEXT UNIQUE,
    is_pro BOOLEAN DEFAULT FALSE,
    proposal_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  )
`).catch(function(err) { console.error('Users table create error:', err.message); });

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many requests. Please wait a minute.' },
});
app.use('/generate', limiter);

// OTP rate limiter - max 3 sends per 10 minutes per IP
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  message: { error: 'Too many OTP requests. Please wait 10 minutes.' },
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({
    status: 'Amalite backend is running',
    version: '8.0 (OTP Auth + Gemini)',
    model: 'gemini-2.5-flash',
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    hasRazorpay: !!process.env.RAZORPAY_KEY_ID,
    hasResend: !!process.env.RESEND_API_KEY,
  });
});

// ─── GENERATE ─────────────────────────────────────────────────────────────────
app.post('/generate', async function(req, res) {
  var system = req.body.system || '';
  var message = req.body.message;
  if (!message) return res.status(400).json({ error: 'message required' });

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
    // Delete any existing unused OTPs for this email
    await pool.query('DELETE FROM otp_codes WHERE email = $1', [email]);

    // Store new OTP
    await pool.query(
      'INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)',
      [email, code, expiresAt]
    );

    // Send email via Resend
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'noreply@amalite.com',
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

  try {
    // Find valid OTP
    var result = await pool.query(
      'SELECT * FROM otp_codes WHERE email = $1 AND code = $2 AND used = FALSE AND expires_at > NOW()',
      [email, code]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired code. Please request a new one.' });
    }

    // Mark OTP as used
    await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [result.rows[0].id]);

    // Create or find user
    var userId = email.replace(/[^a-z0-9]/g, '_') + '_amalite';
    await pool.query(
      `INSERT INTO users (user_id, name, email) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name`,
      [userId, name, email]
    );

    // Get user pro status
    var userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    var user = userResult.rows[0];

    res.json({
      success: true,
      user_id: user.user_id,
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
      // Mark user as pro in DB
      if (user_id) {
        await pool.query('UPDATE users SET is_pro = TRUE WHERE user_id = $1', [user_id]);
      }
      res.json({ success: true, is_pro: true, payment_id: payment_id });
    } else {
      res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Amalite backend v8.0 running on port ' + PORT);
});
