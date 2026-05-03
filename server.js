const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const mammoth = require('mammoth');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '5mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Rate limiting — 10 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please wait a minute and try again.' },
});
app.use('/generate-proposal', limiter);
app.use('/extract-text', limiter);

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
