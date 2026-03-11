const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function sendConfirmationEmail(lead) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'itsadecline <noreply@itsadecline.com>',
      to: [lead.email],
      subject: "We've received your enquiry — itsadecline.com",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2332;">
          <div style="background:#1a2332;padding:24px 32px;border-radius:8px 8px 0 0;">
            <h1 style="color:#f59e0b;margin:0;font-size:22px;">itsadecline.com</h1>
            <p style="color:#94a3b8;margin:4px 0 0;">Specialist Finance Brokerage</p>
          </div>
          <div style="background:#f9fafb;padding:32px;border-radius:0 0 8px 8px;">
            <h2 style="color:#1a2332;margin-top:0;">Hi ${lead.name},</h2>
            <p>Thank you for submitting your enquiry. We've received your details and a member of our team will be in touch shortly.</p>
            <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:20px 0;">
              <h3 style="margin-top:0;color:#374151;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;">Your Enquiry Summary</h3>
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <tr><td style="padding:6px 0;color:#6b7280;">Name</td><td style="padding:6px 0;font-weight:600;">${lead.name}</td></tr>
                <tr><td style="padding:6px 0;color:#6b7280;">Email</td><td style="padding:6px 0;">${lead.email}</td></tr>
                <tr><td style="padding:6px 0;color:#6b7280;">Phone</td><td style="padding:6px 0;">${lead.phone || '—'}</td></tr>
                ${lead.postcode ? `<tr><td style="padding:6px 0;color:#6b7280;">Postcode</td><td style="padding:6px 0;">${lead.postcode}</td></tr>` : ''}
                ${lead.loan_amount ? `<tr><td style="padding:6px 0;color:#6b7280;">Loan Amount</td><td style="padding:6px 0;">£${Number(lead.loan_amount).toLocaleString()}</td></tr>` : ''}
              </table>
            </div>
            <p>To proceed with your application, please review and accept our Terms & Conditions:</p>
            <a href="https://itsadecline.com/tcs-acceptance.html" style="display:inline-block;background:#f59e0b;color:#1a2332;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;">Review Terms &amp; Conditions →</a>
            <p style="margin-top:24px;font-size:13px;color:#6b7280;">
              Questions? Email us at <a href="mailto:sl@itsadecline.com" style="color:#f59e0b;">sl@itsadecline.com</a>
            </p>
          </div>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error: ${res.status} ${body}`);
  }
  return res.json();
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
      postcode,
      property_value,
      mortgage_balance,
      loan_amount,
      message,
    } = body || {};

    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required' });
    }

    // Insert lead into Supabase
    const { data: lead, error } = await supabase
      .from('leads')
      .insert({
        name,
        email,
        phone: phone || null,
        postcode: postcode || null,
        property_value: property_value ? Number(property_value) : null,
        mortgage_balance: mortgage_balance ? Number(mortgage_balance) : null,
        loan_amount: loan_amount ? Number(loan_amount) : null,
      })
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'Failed to save lead' });
    }

    // Send confirmation email (non-fatal if it fails)
    if (process.env.RESEND_API_KEY) {
      try {
        await sendConfirmationEmail({ name, email, phone, postcode, loan_amount });
      } catch (emailErr) {
        console.error('Confirmation email failed:', emailErr.message);
      }
    }

    // Redirect to T&Cs page
    res.setHeader('Location', '/tcs-acceptance.html');
    return res.status(302).end();
  } catch (err) {
    console.error('submit-lead error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
