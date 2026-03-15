const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

    // Send internal notification (non-fatal)
    try {
      await sendNotificationEmail({ name, email, phone, address: fullAddress, postcode, property_value: propVal, mortgage_balance: mortgageBal, loan_amount: loanAmt, ltv: ltvNum, available_equity: equityNum });
    } catch (emailErr) {
      console.error('Notification email failed:', emailErr.message);
    }

    return res.status(200).json({ success: true, lead_id: lead.id });
  } catch (err) {
    console.error('submit-lead error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
