const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const app = express();

app.use(cors({ origin: ['https://itsadecline.com', 'https://www.itsadecline.com', 'https://installsmart.ai', 'https://www.installsmart.ai', 'https://s7ssl.github.io'] }));

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


// ISA Lead Capture
app.post('/api/isa-lead', (req, res) => {
  const { firstname, company, email } = req.body || {};
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });
  const https = require('https');
  const hsToken = process.env.HUBSPOT_TOKEN;
  if (!hsToken) { console.error('[isa-lead] HUBSPOT_TOKEN not set'); return res.json({ success: true }); }
  const payload = JSON.stringify({ properties: { email, firstname: firstname||'', company: company||'', hs_lead_status: 'NEW', lifecyclestage: 'lead' } });
  const opts = { hostname: 'api.hubspot.com', path: '/crm/v3/objects/contacts', method: 'POST', headers: { 'Authorization': 'Bearer ' + hsToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
  const hsReq = https.request(opts, (hsRes) => {
    let body = ''; hsRes.on('data', c => body += c);
    hsRes.on('end', () => { const r = JSON.parse(body); console.log('[isa-lead]', r.id ? 'contact:'+r.id : 'err:'+body.substring(0,100)); });
  });
  hsReq.on('error', e => console.error('[isa-lead]', e.message));
  hsReq.write(payload); hsReq.end();
  res.json({ success: true });
});

// --- Meta Lead Gen Webhook ---
// Verification endpoint (GET)
app.get('/api/meta-leads', (req, res) => {
  const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'itsa_meta_leads_2026';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[meta-leads] Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Lead notification endpoint (POST)
app.post('/api/meta-leads', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately
  try {
    const body = req.body;
    if (body.object !== 'page') return;
    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        if (change.field !== 'leadgen') continue;
        const leadgenId = change.value.leadgen_id;
        const pageId = change.value.page_id;
        // Fetch lead data from Meta
        const PAGE_TOKEN = process.env.META_PAGE_TOKEN;
        const metaRes = await fetch(`https://graph.facebook.com/v19.0/${leadgenId}?fields=field_data,created_time&access_token=${PAGE_TOKEN}`);
        const lead = await metaRes.json();
        if (lead.error) { console.error('[meta-leads] fetch error', lead.error); continue; }
        // Parse fields
        const fields = {};
        for (const f of (lead.field_data || [])) {
          fields[f.name] = f.values[0];
        }
        const name = fields['full_name'] || fields['first_name'] || '';
        const email = fields['email'] || '';
        const phone = fields['phone_number'] || '';
        const loanAmount = fields['loan_amount'] || '';
        console.log(`[meta-leads] New lead: ${name} | ${email} | ${phone} | loan: ${loanAmount}`);
        // Save to Supabase
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
        if (SUPABASE_URL && SUPABASE_KEY) {
          await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
            method: 'POST',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({ name, email, phone, address: loanAmount, source: 'meta_leadgen', status: 'new' })
          });
        }
        // Email notification via Gmail gog token (sat@itsadecline.com)
        const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'sat@itsadecline.com';
        const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
        if (SENDGRID_KEY) {
          await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: NOTIFY_EMAIL }] }],
              from: { email: 'noreply@itsadecline.com', name: 'itsadecline' },
              subject: `New lead: ${name || 'Unknown'}`,
              content: [{ type: 'text/plain', value: `New Meta lead:\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\nLoan amount: ${loanAmount}\nTime: ${lead.created_time}` }]
            })
          });
        }
      }
    }
  } catch (e) {
    console.error('[meta-leads] error:', e.message);
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'itsadecline-api' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`itsadecline API running on port ${PORT}`));
