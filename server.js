const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '20mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
app.use('/generate-proposal', limiter);

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({
    status: 'Amalite backend is running',
    version: '5.0',
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    hasRazorpay: !!process.env.RAZORPAY_KEY_ID,
  });
});

app.get('/test', function(req, res) {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ─── GENERATE PROPOSAL ────────────────────────────────────────────────────────
app.post('/generate', async function(req, res) {
  var system = req.body.system;
  var message = req.body.message;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    var result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: system || 'You are a professional freelance proposal writer.',
      messages: [{ role: 'user', content: message }],
    });
    res.json({ content: result.content[0].text });
  } catch (error) {
    console.error('/generate error:', error.message);
    res.status(500).json({ error: 'AI generation failed', detail: error.message });
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
  } catch (error) {
    res.status(500).json({ error: 'Generation failed', detail: error.message });
  }
});
app.get('/payment/checkout', function(req, res) {
  var keyId = req.query.key_id || '';
  var orderId = req.query.order_id || '';
  var amount = req.query.amount || '';
  var currency = req.query.currency || 'INR';
  var html = '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script src="https://checkout.razorpay.com/v1/checkout.js"></script><style>body{margin:0;padding:20px;background:#0A0A18;color:white;text-align:center;font-family:-apple-system,sans-serif;}.msg{margin-top:40px;font-size:16px;color:#2DD4BF;}</style></head><body><div class="msg" id="status">Opening secure payment...</div><script>var options={key:"' + keyId + '",amount:"' + amount + '",currency:"' + currency + '",name:"Amalite",description:"Pro Monthly Plan",order_id:"' + orderId + '",theme:{color:"#2DD4BF"},handler:function(r){document.getElementById("status").innerText="Verifying...";window.ReactNativeWebView.postMessage(JSON.stringify({type:"PAYMENT_SUCCESS",payment_id:r.razorpay_payment_id,order_id:r.razorpay_order_id,signature:r.razorpay_signature}));},modal:{ondismiss:function(){window.ReactNativeWebView.postMessage(JSON.stringify({type:"PAYMENT_DISMISSED"}));}}};window.onload=function(){var rzp=new Razorpay(options);rzp.on("payment.failed",function(r){window.ReactNativeWebView.postMessage(JSON.stringify({type:"PAYMENT_FAILED",error:r.error.description}));});rzp.open();};</script></body></html>';
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});
// ─── RAZORPAY: CREATE ORDER ───────────────────────────────────────────────────
app.post('/payment/create-order', async function(req, res) {
  try {
    var order = await razorpay.orders.create({
      amount: 399,        // $3.99 in smallest unit (paise for INR, cents for USD)
      currency: 'INR',   // Razorpay test mode uses INR
      receipt: 'amalite_pro_' + Date.now(),
      notes: {
        google_id: req.body.google_id || 'guest',
        plan: 'pro_monthly',
      },
    });

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('/payment/create-order error:', error.message);
    res.status(500).json({ error: 'Could not create payment order', detail: error.message });
  }
});

// ─── RAZORPAY: VERIFY PAYMENT ────────────────────────────────────────────────
app.post('/payment/verify', function(req, res) {
  var order_id = req.body.order_id;
  var payment_id = req.body.payment_id;
  var signature = req.body.signature;
  var google_id = req.body.google_id;

  try {
    // Verify signature
    var body = order_id + '|' + payment_id;
    var expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature === signature) {
      // Payment verified - mark user as Pro
      console.log('Payment verified for:', google_id, 'payment:', payment_id);
      res.json({ success: true, is_pro: true, payment_id: payment_id });
    } else {
      res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }
  } catch (error) {
    console.error('/payment/verify error:', error.message);
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// ─── USER ENDPOINTS ───────────────────────────────────────────────────────────
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

// ─── START ────────────────────────────────────────────────────────────────────
var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Amalite backend v5.0 running on port ' + PORT);
  console.log('Razorpay ready:', !!process.env.RAZORPAY_KEY_ID);
});
