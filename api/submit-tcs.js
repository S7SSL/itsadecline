const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let body = req.body;

    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        const params = new URLSearchParams(body);
        body = Object.fromEntries(params.entries());
      }
    }

    const {
      case_ref,
      full_name,
      email,
      ip_address,
      timestamp,
      signature_data,
    } = body || {};

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    // Build update payload
    const updatePayload = {
      tcs_accepted: true,
      tcs_timestamp: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
      signature_data: signature_data || null,
    };

    // Update lead record — match by email, optionally also filter by case_ref context
    let query = supabase
      .from('leads')
      .update(updatePayload)
      .eq('email', email)
      .eq('tcs_accepted', false); // Only update if not already accepted

    const { data, error } = await query.select();

    if (error) {
      console.error('Supabase update error:', error);
      return res.status(500).json({ error: 'Failed to update T&Cs acceptance' });
    }

    // Log acceptance details for audit trail
    console.log('T&Cs accepted:', {
      email,
      full_name,
      case_ref,
      ip_address,
      timestamp: updatePayload.tcs_timestamp,
      records_updated: data?.length || 0,
    });

    return res.status(200).json({
      success: true,
      message: 'Terms and conditions accepted successfully',
      records_updated: data?.length || 0,
    });
  } catch (err) {
    console.error('submit-tcs error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
