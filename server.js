const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '20mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many requests. Please wait a minute.' },
});
app.use('/generate', limiter);
app.use('/generate-proposal', limiter);

app.get('/health', function(req, res) {
  res.json({
    status: 'Amalite backend is running',
    version: '3.0',
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
  });
});

app.get('/test', function(req, res) {
  res.json({ ok: true, message: 'Connection working!', timestamp: new Date().toISOString() });
});

app.post('/generate', async function(req, res) {
  var system = req.body.system;
  var message = req.body.message;

  if (!message) {
    return res.status(400).json({ error: 'message field is required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server' });
  }

  try {
    var result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: system || 'You are a professional freelance proposal writer. Write plain text only, no markdown.',
      messages: [{ role: 'user', content: message }],
    });
    var text = result.content[0] ? result.content[0].text : '';
    res.json({ content: text });
  } catch (error) {
    console.error('/generate error:', error.message);
    res.status(500).json({ error: 'AI generation failed', detail: error.message });
  }
});

app.post('/generate-proposal', async function(req, res) {
  var prompt = req.body.prompt;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    var result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: 'You are an Upwork proposal writer. Output plain text only. No markdown, no asterisks.',
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ proposal: result.content[0] ? result.content[0].text : '' });
  } catch (error) {
    console.error('/generate-proposal error:', error.message);
    res.status(500).json({ error: 'Generation failed', detail: error.message });
  }
});

app.post('/extract-text', async function(req, res) {
  var base64 = req.body.base64;
  var filename = req.body.filename;
  if (!base64 || !filename) return res.status(400).json({ error: 'Missing file data' });

  try {
    var buffer = Buffer.from(base64, 'base64');
    var ext = filename.split('.').pop().toLowerCase();
    var text = '';
    if (ext === 'docx' || ext === 'doc') {
      var mammoth = require('mammoth');
      var result = await mammoth.extractRawText({ buffer: buffer });
      text = result.value;
    } else if (ext === 'txt') {
      text = buffer.toString('utf8');
    } else {
      text = '[File attached]';
    }
    res.json({ text: text.slice(0, 3000) });
  } catch (error) {
    res.status(500).json({ error: 'Could not read file' });
  }
});

app.post('/user/sync', function(req, res) {
  var google_id = req.body.google_id;
  var name = req.body.name;
  var email = req.body.email;
  if (!google_id) return res.status(400).json({ error: 'google_id required' });
  res.json({ google_id: google_id, name: name || '', email: email || '', proposal_count: 0, is_pro: false });
});

app.get('/user/:google_id', function(req, res) {
  res.json({ google_id: req.params.google_id, proposal_count: 0, is_pro: false });
});

app.post('/user/:google_id/increment', function(req, res) {
  res.json({ success: true });
});

app.post('/payment/create-order', function(req, res) {
  res.json({ checkout_url: null, amount: 399, currency: 'USD', message: 'Payment not yet configured' });
});

app.post('/payment/verify', function(req, res) {
  res.json({ success: false, message: 'Payment not yet configured' });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Amalite backend v3.0 running on port ' + PORT);
  console.log('API key set: ' + !!process.env.ANTHROPIC_API_KEY);
});
