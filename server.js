const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const mammoth = require('mammoth');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const Razorpay = require('razorpay');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '5mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Create tables on startup
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        google_id VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        email VARCHAR(255) UNIQUE,
        is_pro BOOLEAN DEFAULT FALSE,
        proposal_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS proposals (
        id SERIAL PRIMARY KEY,
        google_id VARCHAR(255) NOT NULL,
        job_snippet TEXT,
        verdict VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        google_id VARCHAR(255) NOT NULL,
        razorpay_subscription_id VARCHAR(255),
        razorpay_payment_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
        amount INTEGER DEFAULT 29900,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database tables ready');
  } catch (error) {
    console.error('DB init error:', error);
  }
};
initDB();

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please wait a minute and try again.' },
});
app.use('/generate-proposal', limiter);
app.use('/extract-text', limiter);

// Save or get user
app.post('/user/sync', async (req, res) => {
  const { google_id, name, email } = req.body;
  if (!google_id) return res.status(400).json({ error: 'google_id required' });
  try {
    const result = await pool.query(`
      INSERT INTO users (google_id, name, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (google_id) DO UPDATE
      SET name = $2, email = $3, updated_at = NOW()
      RETURNING *;
    `, [google_id, name, email]);
    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('User sync error:', error);
    res.status(500).json({ error: 'Failed to sync user' });
  }
});

// Get user proposal count and pro status
app.get('/user/:google_id', async (req, res) => {
  const { google_id } = req.params;
  try {
    const result = await pool.query(
      'SELECT proposal_count, is_pro FROM users WHERE google_id = $1',
      [google_id]
    );
    if (result.rows.length === 0) return res.json({ proposal_count: 0, is_pro: false });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Increment proposal count
app.post('/user/:google_id/increment', async (req, res) => {
  const { google_id } = req.params;
  const { job_snippet, verdict } = req.body;
  try {
    const result = await pool.query(`
      UPDATE users
      SET proposal_count = proposal_count + 1, updated_at = NOW()
      WHERE google_id = $1
      RETURNING proposal_count, is_pro;
    `, [google_id]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await pool.query(`
      INSERT INTO proposals (google_id, job_snippet, verdict)
      VALUES ($1, $2, $3);
    `, [google_id, job_snippet?.slice(0, 200) || '', verdict || '']);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Increment error:', error);
    res.status(500).json({ error: 'Failed to increment count' });
  }
});

// Create Razorpay order for Pro subscription
app.post('/payment/create-order', async (req, res) => {
  const { google_id } = req.body;
  if (!google_id) return res.status(400).json({ error: 'google_id required' });
  try {
    const order = await razorpay.orders.create({
      amount: 29900, // Rs.299 in paise
      currency: 'INR',
      receipt: `amalite_${google_id}_${Date.now()}`,
      notes: { google_id },
    });
    res.json({ order_id: order.id, amount: order.amount, currency: order.currency });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// Verify Razorpay payment and unlock Pro
app.post('/payment/verify', async (req, res) => {
  const { google_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!google_id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment details' });
  }
  try {
    // Verify signature
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // Unlock Pro in database
    await pool.query(`
      UPDATE users SET is_pro = TRUE, updated_at = NOW()
      WHERE google_id = $1;
    `, [google_id]);

    // Save subscription record
    await pool.query(`
      INSERT INTO subscriptions (google_id, razorpay_payment_id, status)
      VALUES ($1, $2, 'active');
    `, [google_id, razorpay_payment_id]);

    res.json({ success: true, message: 'Pro unlocked successfully' });
  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Generate proposal endpoint
app.post('/generate-proposal', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
  if (prompt.length > 8000) return res.status(400).json({ error: 'Request too large' });
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: 'You are an Upwork proposal writer. Output plain text only. Never use markdown formatting. Never use asterisks, pound signs, bold markers, or special unicode box characters. Use only plain dashes for bullet points. Use these exact headers on their own lines: VERDICT: and COVER LETTER: and SCREENING QUESTIONS: and STRATEGY: and SKIP REASON:',
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ proposal: message.content[0].text });
  } catch (error) {
    console.error('Generate error:', error);
    res.status(500).json({ error: 'Failed to generate proposal' });
  }
});

// File text extraction endpoint
app.post('/extract-text', async (req, res) => {
  const { base64, filename, mimeType } = req.body;
  if (!base64 || !filename) return res.status(400).json({ error: 'Missing file data' });
  if (base64.length > 4000000) return res.status(400).json({ error: 'File too large' });
  try {
    const buffer = Buffer.from(base64, 'base64');
    const ext = filename.split('.').pop()?.toLowerCase();
    let text = '';
    if (ext === 'docx' || ext === 'doc') {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === 'pdf') {
      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
            { type: 'text', text: 'Extract all text from this document. Output only the raw text content, no commentary.' },
          ],
        }],
      });
      text = message.content[0].type === 'text' ? message.content[0].text : '';
    } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
      text = buffer.toString('utf8').replace(/[^\x20-\x7E\n\r\t]/g, ' ').slice(0, 3000);
    } else {
      text = buffer.toString('utf8');
    }
    res.json({ text: text.slice(0, 3000) });
  } catch (error) {
    console.error('Extract error:', error);
    res.status(500).json({ error: 'Could not extract text from file' });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'Amalite backend is running' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Amalite backend running on port ${PORT}`));