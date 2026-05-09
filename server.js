const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '20mb' }));

// ─── ANTHROPIC CLIENT ─────────────────────────────────────────────────────────
// Make sure ANTHROPIC_API_KEY is set in your .env file (local)
// and in Railway Variables (production)
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many requests. Please wait a minute.' },
});
app.use('/generate', limiter);
app.use('/generate-proposal', limiter);

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'Amalite backend is running',
    version: '2.1',
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
  });
});

// ─── TEST ENDPOINT (no AI, just confirms routing works) ───────────────────────
app.get('/test', (req, res) => {
  res.json({ ok: true, message: 'Connection working!', timestamp: new Date().toISOString() });
});

// ─── /generate — used by proposal-generator.tsx ───────────────────────────────
app.post('/generate', async (req, res) => {
  const { system, message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message field is required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server' });
  }

  try {
    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: system || 'You are a professional freelance proposal writer. Write plain text only, no markdown.',
      messages: [{ role: 'user', content: message }],
    });

    const text = result.content[0]?.text || '';
    res.json({ content: text });

  } catch (error: any) {
    console.error('/generate error:', error?.message || error);
    res.status(500).json({
      error: 'AI generation failed',
      detail: error?.message || 'Unknown error',
    });
  }
});

// ─── /generate-proposal — legacy endpoint (kept for safety) ───────────────────
app.post('/generate-proposal', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: 'You are an Upwork proposal writer. Output plain text only. No markdown, no asterisks.',
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ proposal: result.content[0]?.text || '' });
  } catch (error: any) {
    console.error('/generate-proposal error:', error?.message);
    res.status(500).json({ error: 'Generation failed', detail: error?.message });
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
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === 'txt') {
      text = buffer.toString('utf8');
    } else {
      text = '[File attached — see attachment for details]';
    }

    res.json({ text: text.slice(0, 3000) });
  } catch (error: any) {
    console.error('/extract-text error:', error?.message);
    res.status(500).json({ error: 'Could not read file' });
  }
});

// ─── USER ENDPOINTS ───────────────────────────────────────────────────────────
app.post('/user/sync', (req, res) => {
  const { google_id, name, email } = req.body;
  if (!google_id) return res.status(400).json({ error: 'google_id required' });
  res.json({ google_id, name: name || '', email: email || '', proposal_count: 0, is_pro: false });
});

app.get('/user/:google_id', (req, res) => {
  res.json({ google_id: req.params.google_id, proposal_count: 0, is_pro: false });
});

app.post('/user/:google_id/increment', (req, res) => {
  res.json({ success: true });
});

// ─── PAYMENT ENDPOINTS ────────────────────────────────────────────────────────
app.post('/payment/create-order', (req, res) => {
  // TODO: Replace with real Stripe or Razorpay integration
  // For now returns a placeholder so the app doesn't crash
  res.json({
    checkout_url: null, // set to real URL when payment is ready
    amount: 399,
    currency: 'USD',
    message: 'Payment gateway not yet configured',
  });
});

app.post('/payment/verify', (req, res) => {
  res.json({ success: false, message: 'Payment gateway not yet configured' });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Amalite backend v2.1 running on port ${PORT}`);
  console.log(`   API key set: ${!!process.env.ANTHROPIC_API_KEY}`);
});
