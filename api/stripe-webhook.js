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

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

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
};
