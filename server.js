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
        // Fire Conversions API event to Meta (server-side Lead event)
        const PIXEL_ID = process.env.META_PIXEL_ID || '1117581533832863';
        const CAPI_TOKEN = process.env.META_PAGE_TOKEN;
        if (CAPI_TOKEN) {
          try {
            const crypto = require('crypto');
            const hashFn = v => v ? crypto.createHash('sha256').update(v.trim().toLowerCase()).digest('hex') : undefined;
            const capiPayload = {
              data: [{
                event_name: 'Lead',
                event_time: Math.floor(Date.now() / 1000),
                action_source: 'system_generated',
                user_data: {
                  em: email ? [hashFn(email)] : undefined,
                  ph: phone ? [hashFn(phone.replace(/\D/g,''))] : undefined,
                  fn: name ? [hashFn(name.split(' ')[0])] : undefined,
                  ln: name && name.includes(' ') ? [hashFn(name.split(' ').slice(1).join(' '))] : undefined,
                  country: [hashFn('gb')]
                },
                custom_data: { loan_amount: loanAmount, lead_source: 'meta_leadgen' }
              }]
            };
            await fetch(`https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${CAPI_TOKEN}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(capiPayload)
            });
            console.log('[meta-leads] CAPI Lead event fired for pixel', PIXEL_ID);
          } catch (capiErr) {
            console.error('[meta-leads] CAPI error:', capiErr.message);
          }
        }

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
        // Email notification via Gmail API (sat@itsadecline.com)
        const GMAIL_REFRESH_TOKEN = process.env.ITSA_GMAIL_REFRESH_TOKEN;
        const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
        const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
        if (GMAIL_REFRESH_TOKEN && GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
          try {
            // Get access token
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: GMAIL_REFRESH_TOKEN, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET })
            });
            const tokenData = await tokenRes.json();
            const accessToken = tokenData.access_token;
            if (accessToken) {
              const subject = `New ITSA lead: ${name || 'Unknown'}`;
              const receivedDate = new Date(lead.created_time).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/London' });
              const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f4f5;margin:0;padding:32px 16px}
.card{background:#ffffff;border-radius:12px;max-width:520px;margin:0 auto;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.08)}
.logo{font-size:22px;font-weight:700;color:#0a0f1a;letter-spacing:-0.5px;margin-bottom:24px}
.logo span{color:#00e5ff}
h2{font-size:18px;font-weight:600;color:#0a0f1a;margin:0 0 24px}
.field{margin-bottom:16px}
.label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:#6b7280;margin-bottom:4px}
.value{font-size:16px;color:#0a0f1a;font-weight:500}
.divider{border:none;border-top:1px solid #e5e7eb;margin:24px 0}
.cta{display:inline-block;background:#00e5ff;color:#0a0f1a;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;margin-top:8px}
.footer{font-size:12px;color:#9ca3af;margin-top:24px;text-align:center}
</style></head><body>
<div class="card">
  <div class="logo">its<span>a</span>decline</div>
  <h2>New lead received</h2>
  <div class="field"><div class="label">Name</div><div class="value">${name || '—'}</div></div>
  <div class="field"><div class="label">Email</div><div class="value">${email || '—'}</div></div>
  <div class="field"><div class="label">Phone</div><div class="value">${phone || '—'}</div></div>
  <div class="field"><div class="label">Loan amount</div><div class="value">${loanAmount || '—'}</div></div>
  <div class="field"><div class="label">Received</div><div class="value">${receivedDate}</div></div>
  <hr class="divider">
  <a href="https://adsmanager.facebook.com/adsmanager/manage/leads?act=2060604164786586" class="cta">View in Ads Manager →</a>
  <div class="footer">itsadecline.com · Kaizen Finance Ltd</div>
</div>
</body></html>`;
              const rawEmail = Buffer.from(`To: sat@itsadecline.com\r\nFrom: sat@itsadecline.com\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${htmlBody}`).toString('base64url');
              await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ raw: rawEmail })
              });
              console.log('[meta-leads] Notification email sent for lead:', name);

              // Send follow-up email TO THE LEAD
              if (email && !email.includes('test@meta')) {
                const firstName = name ? name.split(' ')[0] : 'there';
                const leadSubject = `Your free assessment — itsadecline.com`;
                const leadHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f4f5;margin:0;padding:32px 16px}.card{background:#ffffff;border-radius:12px;max-width:520px;margin:0 auto;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.08)}.logo{font-size:22px;font-weight:700;color:#0a0f1a;letter-spacing:-0.5px;margin-bottom:24px}.logo span{color:#00e5ff}p{color:#374151;line-height:1.7;margin:0 0 16px}.cta{display:inline-block;background:#00e5ff;color:#0a0f1a;font-weight:700;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none;margin:8px 8px 8px 0}.cta2{display:inline-block;background:#0a0f1a;color:#ffffff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;margin:8px 0}.divider{border:none;border-top:1px solid #e5e7eb;margin:24px 0}.footer{font-size:12px;color:#9ca3af;margin-top:24px}</style></head><body>
<div class="card">
  <div class="logo">its<span>a</span>decline</div>
  <p>Hi ${firstName},</p>
  <p>Thanks for reaching out. We're here to help you find a way forward after a mortgage decline.</p>
  <p>To assess your options, we need a few more details about your property. It takes under 2 minutes:</p>
  <a href="https://itsadecline.com" class="cta">Complete Your Assessment →</a>
  <hr class="divider">
  <p>You can also book a free 30-minute call with our team:</p>
  <a href="https://calendly.com/sat-installsmart/30min" class="cta2">Book a Call</a>
  <div class="footer">itsadecline.com · Kaizen Finance Ltd · <a href="https://itsadecline.com/privacy" style="color:#9ca3af;">Privacy Policy</a></div>
</div>
</body></html>`;
                const rawLeadEmail = Buffer.from(`To: ${email}\r\nFrom: sat@itsadecline.com\r\nSubject: ${leadSubject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${leadHtml}`).toString('base64url');
                await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ raw: rawLeadEmail })
                });
                console.log('[meta-leads] Follow-up email sent to lead:', email);
              }
            }
          } catch (emailErr) {
            console.error('[meta-leads] Email error:', emailErr.message);
          }
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
