const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const mammoth = require('mammoth');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '20mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many requests. Please wait a minute and try again.' },
});
app.use('/generate', limiter);
app.use('/generate-proposal', limiter);
app.use('/extract-text', limiter);

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'Amalite backend is running', version: '2.0' });
});

// ─── NEW: /generate endpoint (used by updated proposal-generator.tsx) ─────────
// Accepts { system, message } and returns { content }
app.post('/generate', async (req, res) => {
  const { system, message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (message.length > 10000) return res.status(400).json({ error: 'Request too large' });

  try {
    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: system || 'You are a professional freelance proposal writer.',
      messages: [{ role: 'user', content: message }],
    });
    res.json({ content: result.content[0].text });
  } catch (error) {
    console.error('/generate error:', error);
    res.status(500).json({ error: 'Failed to generate proposal. Please try again.' });
  }
});

// ─── LEGACY: /generate-proposal (kept for backwards compat) ──────────────────
app.post('/generate-proposal', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
  if (prompt.length > 8000) return res.status(400).json({ error: 'Request too large' });

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: 'You are an Upwork proposal writer. Output plain text only. No markdown, no asterisks, no special characters. Use plain dashes for bullet points only.',
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ proposal: message.content[0].text });
  } catch (error) {
    console.error('/generate-proposal error:', error);
    res.status(500).json({ error: 'Failed to generate proposal' });
  }
});

// ─── FILE TEXT EXTRACTION ─────────────────────────────────────────────────────
app.post('/extract-text', async (req, res) => {
  const { base64, filename } = req.body;
  if (!base64 || !filename) return res.status(400).json({ error: 'Missing file data' });

  try {
    const buffer = Buffer.from(base64, 'base64');
    const ext = filename.split('.').pop().toLowerCase();

    let text = '';
    if (ext === 'docx' || ext === 'doc') {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === 'txt') {
      text = buffer.toString('utf8');
    } else if (ext === 'pdf') {
      text = '[PDF attached — client can see this document]';
    } else {
      text = '[File attached]';
    }

    res.json({ text: text.slice(0, 3000) });
  } catch (error) {
    console.error('/extract-text error:', error);
    res.status(500).json({ error: 'Could not read file' });
  }
});

// ─── USER SYNC (Google Sign-In) ───────────────────────────────────────────────
app.post('/user/sync', async (req, res) => {
  const { google_id, name, email } = req.body;
  if (!google_id) return res.status(400).json({ error: 'google_id required' });

  try {
    // If you have PostgreSQL set up on Railway, use the DB queries below.
    // For now returns a default response so the app doesn't crash.
    res.json({
      google_id,
      name: name || '',
      email: email || '',
      proposal_count: 0,
      is_pro: false,
    });
  } catch (error) {
    console.error('/user/sync error:', error);
    res.status(500).json({ error: 'User sync failed' });
  }
});

// ─── GET USER ────────────────────────────────────────────────────────────────
app.get('/user/:google_id', async (req, res) => {
  const { google_id } = req.params;
  try {
    // Returns safe defaults if DB not set up yet
    res.json({
      google_id,
      proposal_count: 0,
      is_pro: false,
    });
  } catch (error) {
    console.error('/user/:id error:', error);
    res.status(500).json({ error: 'Could not fetch user' });
  }
});

// ─── INCREMENT PROPOSAL COUNT ─────────────────────────────────────────────────
app.post('/user/:google_id/increment', async (req, res) => {
  const { google_id } = req.params;
  try {
    res.json({ success: true, google_id });
  } catch (error) {
    console.error('/user/increment error:', error);
    res.status(500).json({ error: 'Could not update count' });
  }
});

// ─── PAYMENT: CREATE ORDER ────────────────────────────────────────────────────
app.post('/payment/create-order', async (req, res) => {
  const { google_id, amount, currency } = req.body;
  try {
    // Placeholder — returns a direct payment URL until Stripe/Razorpay keys are live
    res.json({
      checkout_url: 'https://amalite.app/upgrade',
      amount: amount || 399,
      currency: currency || 'USD',
    });
  } catch (error) {
    console.error('/payment/create-order error:', error);
    res.status(500).json({ error: 'Payment creation failed' });
  }
});

// ─── PAYMENT: VERIFY ─────────────────────────────────────────────────────────
app.post('/payment/verify', async (req, res) => {
  const { google_id, payment_id } = req.body;
  try {
    res.json({ success: true, is_pro: true });
  } catch (error) {
    console.error('/payment/verify error:', error);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Amalite backend v2.0 running on port ${PORT}`);
});