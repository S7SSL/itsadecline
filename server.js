const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const app = express();

app.use(cors({ origin: ['https://itsadecline.com', 'https://www.itsadecline.com'] }));

// Raw body for Stripe webhook signature verification
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Mount API handlers
const stripeWebhook = require('./api/stripe-webhook');
const submitLead = require('./api/submit-lead');
const submitTcs = require('./api/submit-tcs');

app.post('/api/stripe-webhook', stripeWebhook);
app.post('/api/submit-lead', submitLead);
app.post('/api/submit-tcs', submitTcs);
app.post('/api/broker-interest', (req, res) => {
  // Log broker interest and forward to n8n
  const { name, company, email, phone } = req.body;
  fetch(process.env.N8N_WEBHOOK_URL + '-broker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, company, email, phone, source: 'broker-landing' })
  }).catch(e => console.error('n8n broker webhook error:', e));
  res.json({ success: true, message: 'Thanks, we\'ll be in touch shortly.' });
});

// --- HMLR Document Upload ---
// Multer: memory storage (no disk write until full storage integration)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, JPG, and PNG files are accepted.'));
    }
  }
});

app.post('/api/upload-document', upload.single('document'), (req, res) => {
  const case_ref = (req.body && req.body.case_ref) ? req.body.case_ref.trim() : null;
  const file = req.file;

  if (!case_ref) {
    return res.status(400).json({ success: false, message: 'Missing case_ref.' });
  }
  if (!file) {
    return res.status(400).json({ success: false, message: 'No file uploaded.' });
  }

  // Log receipt (storage integration to follow)
  console.log(`[upload-document] case_ref=${case_ref} | file=${file.originalname} | size=${file.size} bytes | mime=${file.mimetype}`);

  // TODO: persist file.buffer to S3 / Supabase Storage with key: uploads/{case_ref}/{filename}

  res.json({ success: true, message: 'Document received' });
});

// Multer error handler
app.use((err, req, res, next) => {
  if (err && err.message) {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'itsadecline-api' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`itsadecline API running on port ${PORT}`));
