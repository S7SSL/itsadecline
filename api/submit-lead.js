const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getGmailAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.ITSA_GMAIL_REFRESH_TOKEN,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET
    })
  });
  const d = await res.json();
  return d.access_token;
}

async function sendPreApprovalEmail(lead) {
  const token = await getGmailAccessToken();
  if (!token) return;
  const firstName = lead.name ? lead.name.split(' ')[0] : 'there';
  const fmt = v => v ? '£' + Number(v).toLocaleString('en-GB') : '—';
  const subject = `You're pre-approved — itsadecline.com`;
  const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f4f5;margin:0;padding:32px 16px}.card{background:#ffffff;border-radius:12px;max-width:520px;margin:0 auto;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.08)}.logo{font-size:22px;font-weight:700;color:#0a0f1a;letter-spacing:-0.5px;margin-bottom:24px}.logo span{color:#00e5ff}p{color:#374151;line-height:1.7;margin:0 0 16px}.highlight{background:#f0fdf4;border-left:4px solid #16a34a;padding:16px;border-radius:4px;margin:20px 0}.highlight strong{color:#15803d;display:block;font-size:18px;margin-bottom:4px}.highlight span{color:#374151;font-size:14px}.cta{display:inline-block;background:#00e5ff;color:#0a0f1a;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px;text-decoration:none;margin-top:16px}.divider{border:none;border-top:1px solid #e5e7eb;margin:24px 0}.footer{font-size:12px;color:#9ca3af;margin-top:24px}</style></head><body>
<div class="card">
  <div class="logo">its<span>a</span>decline</div>
  <p>Hi ${firstName},</p>
  <p>Good news. Based on your property details, you may qualify for a loan advance through our specialist lender panel.</p>
  <div class="highlight">
    <strong>Pre-Approval Estimate</strong>
    <span>Property value: ${fmt(lead.property_value)} &nbsp;·&nbsp; LTV: ${lead.ltv ? lead.ltv + '%' : '—'} &nbsp;·&nbsp; Available equity: ${fmt(lead.available_equity)}</span>
  </div>
  <p>To proceed, review and sign our terms and pay the £295 commitment fee. This covers our case assessment and lender matching:</p>
  <a href="https://itsadecline.com/tcs-acceptance.html" class="cta">Review Terms & Proceed →</a>
  <hr class="divider">
  <p style="font-size:13px;color:#6b7280;">Questions? Reply to this email or call us directly. We aim to respond within 2 hours.</p>
  <div class="footer">itsadecline.com · Kaizen Finance Ltd · <a href="https://itsadecline.com/privacy" style="color:#9ca3af;">Privacy Policy</a></div>
</div>
</body></html>`;
  const raw = Buffer.from(`To: ${lead.email}\r\nFrom: sat@itsadecline.com\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${htmlBody}`).toString('base64url');
  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });
  console.log('[submit-lead] Pre-approval email sent to:', lead.email);
}

async function sendNotificationEmail(lead) {
  // Send via Gmail API using sat@itsadecline.com
  const token = process.env.ITSA_GMAIL_TOKEN;
  if (!token) return;

  const fmt = v => v ? '£' + Number(v).toLocaleString('en-GB') : '—';
  const subject = `New ITSA Lead: ${lead.name} — ${lead.postcode || 'no postcode'}`;
  const body = [
    `New lead from itsadecline.com`,
    ``,
    `Name: ${lead.name}`,
    `Email: ${lead.email}`,
    `Phone: ${lead.phone || '—'}`,
    `Address: ${lead.address || '—'}`,
    `Property Value: ${fmt(lead.property_value)}`,
    `Mortgage Balance: ${fmt(lead.mortgage_balance)}`,
    `Loan Needed: ${fmt(lead.loan_amount)}`,
    `LTV: ${lead.ltv ? lead.ltv + '%' : '—'}`,
    `Available Equity: ${fmt(lead.available_equity)}`,
    ``,
    `View in Supabase: https://gcsorjyxzyltzxpmaavt.supabase.co`,
  ].join('\n');

  const message = [
    `To: sat@itsadecline.com`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body
  ].join('\n');

  const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded })
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let body = req.body;

    // Handle both JSON and form-encoded
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        const params = new URLSearchParams(body);
        body = Object.fromEntries(params.entries());
      }
    }

    const {
      name,
      email,
      phone,
      house_number,
      postcode,
      property_value,
      mortgage_balance,
      loan_amount,
      ltv,
      available_equity,
      message,
    } = body || {};

    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required' });
    }

    const propVal = property_value ? Number(property_value) : null;
    const mortgageBal = mortgage_balance ? Number(mortgage_balance) : null;
    const loanAmt = loan_amount ? Number(loan_amount) : null;
    const ltvNum = ltv ? Number(ltv) : null;
    const equityNum = available_equity ? Number(available_equity) : null;

    const fullAddress = [house_number, postcode].filter(Boolean).join(', ');

    // Insert lead into Supabase
    // Try full schema first, fall back to base fields if new columns not yet migrated
    let lead, error;
    const fullPayload = {
      name, email,
      phone: phone || null,
      postcode: postcode || null,
      property_value: propVal,
      mortgage_balance: mortgageBal,
      loan_amount: loanAmt,
      ltv: ltvNum,
      available_equity: equityNum,
      address: fullAddress || null,
      source: 'homepage',
      status: 'new',
    };

    ({ data: lead, error } = await supabase.from('leads').insert(fullPayload).select().single());

    if (error && error.message && error.message.includes('column')) {
      // Fall back to base columns only
      console.warn('New columns not yet in schema, using base fields');
      ({ data: lead, error } = await supabase.from('leads').insert({
        name, email,
        phone: phone || null,
        postcode: postcode || null,
        property_value: propVal,
        mortgage_balance: mortgageBal,
        loan_amount: loanAmt,
      }).select().single());
    }

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'Failed to save lead' });
    }

    const leadData = { name, email, phone, address: fullAddress, postcode, property_value: propVal, mortgage_balance: mortgageBal, loan_amount: loanAmt, ltv: ltvNum, available_equity: equityNum };

    // Send internal notification (non-fatal)
    try {
      await sendNotificationEmail(leadData);
    } catch (emailErr) {
      console.error('Notification email failed:', emailErr.message);
    }

    // Send pre-approval email to lead if LTV qualifies (≤ 85%)
    if (email && ltvNum && ltvNum <= 85) {
      try {
        await sendPreApprovalEmail(leadData);
      } catch (preApprovalErr) {
        console.error('Pre-approval email failed:', preApprovalErr.message);
      }
    }

    return res.status(200).json({ success: true, lead_id: lead.id });
  } catch (err) {
    console.error('submit-lead error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
