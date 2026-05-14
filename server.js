const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '20mb' }));

// Initialize Gemini (Locked to 2.5-flash to prevent 404 errors)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many requests. Please wait a minute.' },
});
app.use('/generate', limiter);

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({
    status: 'Amalite backend is running',
    version: '7.0 (Master Prompt Engine)',
    model: 'gemini-2.5-flash',
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    hasRazorpay: !!process.env.RAZORPAY_KEY_ID,
  });
});

// ─── GENERATE (Main App Endpoint) ─────────────────────────────────────────────
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
app.post('/payment/verify', function(req, res) {
  var order_id = req.body.order_id;
  var payment_id = req.body.payment_id;
  var signature = req.body.signature;

  try {
    var body = order_id + '|' + payment_id;
    var expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature === signature) {
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
  console.log('Amalite backend v7.0 running on port ' + PORT);
});