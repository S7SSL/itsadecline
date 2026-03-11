const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function generateCaseRef(postcode, surname) {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const cleanPostcode = (postcode || '').replace(/\s+/g, '').toUpperCase();
  const surnamePrefix = (surname || '').slice(0, 3).toUpperCase();
  return `${cleanPostcode}${surnamePrefix}${mm}${yy}`;
}

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'itsadecline <noreply@itsadecline.com>',
        to: [to],
        subject,
        html,
      }),
    });
  } catch (err) {
    console.error('Resend email failed:', err.message);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => (data += chunk));
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // ──────────────────────────────────────────────────────────
  // checkout.session.completed — create case + identity check
  // ──────────────────────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    try {
      const customerEmail = session.customer_details?.email || session.customer_email || '';
      const customerName = session.customer_details?.name || session.metadata?.name || '';
      const postcode = session.metadata?.postcode || '';
      const surname = session.metadata?.surname || customerName.split(' ').slice(-1)[0] || '';

      const caseRef = generateCaseRef(postcode, surname);

      // Look up lead by email to link records
      const { data: leadData } = await supabase
        .from('leads')
        .select('id, phone, property_value, mortgage_balance, loan_amount')
        .eq('email', customerEmail)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      const ltvRatio =
        leadData?.property_value && leadData?.loan_amount
          ? (leadData.loan_amount / leadData.property_value) * 100
          : null;

      // Insert case into Supabase
      const { data: caseData, error: caseError } = await supabase
        .from('cases')
        .insert({
          case_ref: caseRef,
          lead_id: leadData?.id || null,
          name: customerName,
          email: customerEmail,
          phone: leadData?.phone || session.metadata?.phone || null,
          postcode: postcode,
          property_value: leadData?.property_value || null,
          mortgage_balance: leadData?.mortgage_balance || null,
          loan_amount: leadData?.loan_amount || null,
          ltv_ratio: ltvRatio,
          stage: 'RECEIVED',
          stripe_payment_id: session.payment_intent || session.id,
        })
        .select()
        .single();

      if (caseError) {
        console.error('Supabase insert error:', caseError);
        return res.status(500).json({ error: 'Failed to create case' });
      }

      // Mark lead as converted
      if (leadData?.id) {
        await supabase
          .from('leads')
          .update({ converted_to_case: true, stripe_session_id: session.id })
          .eq('id', leadData.id);
      }

      // ── Stripe Identity verification session ──────────────
      try {
        const verificationSession = await stripe.identity.verificationSessions.create({
          type: 'document',
          metadata: { case_ref: caseRef, email: customerEmail },
          options: {
            document: {
              require_matching_selfie: true,
            },
          },
          return_url: `https://itsadecline.com/thank-you.html?ref=${caseRef}`,
        });

        // Store identity session details on the case
        await supabase
          .from('cases')
          .update({
            stripe_identity_session_id: verificationSession.id,
            stripe_identity_url: verificationSession.url,
          })
          .eq('case_ref', caseRef);

        // Email applicant with the verification link
        await sendEmail({
          to: customerEmail,
          subject: 'One last step — verify your identity',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
              <div style="background:#1a2332;padding:24px 32px;border-radius:8px 8px 0 0;">
                <h1 style="color:#f59e0b;margin:0;">itsadecline.com</h1>
              </div>
              <div style="background:#f9fafb;padding:32px;border-radius:0 0 8px 8px;">
                <h2 style="color:#1a2332;">Hi ${customerName},</h2>
                <p>Your payment is confirmed and your case (<strong>${caseRef}</strong>) is open.</p>
                <p>As a final step, your lender requires us to verify your identity securely. This takes under 2 minutes — you'll need your passport or driving licence and a selfie.</p>
                <div style="text-align:center;margin:32px 0;">
                  <a href="${verificationSession.url}"
                     style="background:#f59e0b;color:#1a2332;padding:14px 32px;border-radius:6px;font-weight:700;font-size:16px;text-decoration:none;display:inline-block;">
                    Verify My Identity
                  </a>
                </div>
                <p style="font-size:14px;color:#6b7280;">This link is secure and powered by Stripe Identity. Your data is handled in accordance with our privacy policy.</p>
                <p style="font-size:14px;color:#6b7280;">Questions? Email <a href="mailto:sl@itsadecline.com">sl@itsadecline.com</a> quoting <strong>${caseRef}</strong>.</p>
              </div>
            </div>
          `,
        });
      } catch (identityErr) {
        // Non-fatal — case already created, log and continue
        console.error('Stripe Identity session creation failed:', identityErr.message);
      }

      // Trigger n8n workflow
      if (process.env.N8N_WEBHOOK_URL) {
        try {
          await fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              case_ref: caseRef,
              case_id: caseData.id,
              name: customerName,
              email: customerEmail,
              postcode: postcode,
              stripe_session_id: session.id,
              stripe_payment_id: session.payment_intent,
            }),
          });
        } catch (n8nError) {
          console.error('n8n webhook trigger failed:', n8nError.message);
          // Non-fatal — case already created
        }
      }

      return res.status(200).json({ received: true, case_ref: caseRef });
    } catch (err) {
      console.error('Webhook processing error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // ──────────────────────────────────────────────────────────
  // identity.verification_session.verified — update case
  // ──────────────────────────────────────────────────────────
  if (event.type === 'identity.verification_session.verified') {
    const verificationSession = event.data.object;
    const caseRef = verificationSession.metadata?.case_ref;
    const applicantEmail = verificationSession.metadata?.email;

    if (!caseRef) {
      console.warn('identity.verification_session.verified received without case_ref metadata');
      return res.status(200).json({ received: true });
    }

    try {
      // Mark case as identity verified and advance stage
      const { error: updateError } = await supabase
        .from('cases')
        .update({
          identity_verified: true,
          identity_verified_at: new Date().toISOString(),
          stage: 'KYC',
        })
        .eq('case_ref', caseRef);

      if (updateError) {
        console.error('Failed to update case identity status:', updateError);
        return res.status(500).json({ error: 'Failed to update case' });
      }

      // Internal notification
      await sendEmail({
        to: 'sl@itsadecline.com',
        subject: `✅ Identity verified for case ${caseRef}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;">
            <h2 style="color:#1a2332;">Identity Verified</h2>
            <p>Stripe Identity verification has been completed for case <strong>${caseRef}</strong>.</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr style="background:#f3f4f6;">
                <td style="padding:8px;font-weight:600;">Case Ref</td>
                <td style="padding:8px;">${caseRef}</td>
              </tr>
              <tr>
                <td style="padding:8px;font-weight:600;">Applicant Email</td>
                <td style="padding:8px;">${applicantEmail || 'N/A'}</td>
              </tr>
              <tr style="background:#f3f4f6;">
                <td style="padding:8px;font-weight:600;">Verification Session ID</td>
                <td style="padding:8px;">${verificationSession.id}</td>
              </tr>
              <tr>
                <td style="padding:8px;font-weight:600;">New Stage</td>
                <td style="padding:8px;">KYC</td>
              </tr>
              <tr style="background:#f3f4f6;">
                <td style="padding:8px;font-weight:600;">Verified At</td>
                <td style="padding:8px;">${new Date().toUTCString()}</td>
              </tr>
            </table>
          </div>
        `,
      });

      return res.status(200).json({ received: true, case_ref: caseRef });
    } catch (err) {
      console.error('Identity verification webhook processing error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // All other event types — acknowledge and ignore
  return res.status(200).json({ received: true });
};
