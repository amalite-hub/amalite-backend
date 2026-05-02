const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const mammoth = require('mammoth');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '20mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Generate proposal endpoint
app.post('/generate-proposal', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: 'You are an Upwork proposal writer. Output plain text only. Never use markdown formatting. Never use asterisks, pound signs, bold markers, or special unicode box characters. Use only plain dashes for bullet points. Use these exact headers: VERDICT: and COVER LETTER: and STRATEGY: and SKIP REASON:',
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ proposal: message.content[0].text });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to generate proposal' });
  }
});

// File text extraction endpoint
app.post('/extract-text', async (req, res) => {
  const { base64, filename, mimeType } = req.body;
  if (!base64 || !filename) return res.status(400).json({ error: 'Missing file data' });

  try {
    const buffer = Buffer.from(base64, 'base64');
    const ext = filename.split('.').pop()?.toLowerCase();
    let text = '';

    if (ext === 'docx' || ext === 'doc') {
      // Extract text from Word document
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === 'pdf') {
      // For PDF — send to Claude vision to extract text
      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64,
              },
            },
            {
              type: 'text',
              text: 'Extract all text from this document. Output only the raw text content, no commentary.',
            },
          ],
        }],
      });
      text = message.content[0].type === 'text' ? message.content[0].text : '';
    } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
      // For Excel/CSV — basic text extraction
      text = buffer.toString('utf8').replace(/[^\x20-\x7E\n\r\t]/g, ' ').slice(0, 3000);
    } else {
      // Plain text fallback
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
