const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
app.get('/health', function(req, res) {
  res.json({ status: 'Amalite backend is running', version: '4.0', hasApiKey: !!process.env.ANTHROPIC_API_KEY });
});
app.post('/generate', async function(req, res) {
  var system = req.body.system;
  var message = req.body.message;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    var result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: system || 'You are a professional freelance proposal writer.',
      messages: [{ role: 'user', content: message }],
    });
    res.json({ content: result.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/generate-proposal', async function(req, res) {
  var prompt = req.body.prompt;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    var result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: 'You are an Upwork proposal writer. Plain text only.',
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ proposal: result.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/user/sync', function(req, res) {
  res.json({ google_id: req.body.google_id, proposal_count: 0, is_pro: false });
});
app.get('/user/:google_id', function(req, res) {
  res.json({ google_id: req.params.google_id, proposal_count: 0, is_pro: false });
});
app.post('/user/:google_id/increment', function(req, res) {
  res.json({ success: true });
});
app.post('/payment/create-order', function(req, res) {
  res.json({ checkout_url: null, amount: 399, currency: 'USD' });
});
var PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', function() {
  console.log('Amalite backend v4.0 running on port ' + PORT);
});
