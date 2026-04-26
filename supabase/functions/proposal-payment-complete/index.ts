// proposal-payment-complete  (Flow 2 — single consolidated email)
// -----------------------------------------------------------------------------
// Stripe webhook: checkout.session.completed.
//
//   1. Verify signature (replay-protected, constant-time compare).
//   2. Filter to £295-only events so the booking webhook stays unaffected.
//   3. Look up the signed proposal row by customer email.
//   4. Fetch the signed PDF from Supabase Storage.
//   5. Send ONE email from sat@itsadecline.com to the client, BCC sat,
//      with receipt details in the body + PDF attached.
//   6. Mark proposal status='paid'.
// -----------------------------------------------------------------------------

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY            = Deno.env.get("RESEND_API_KEY")!;
// Distinct from STRIPE_WEBHOOK_SECRET (which signs your booking webhook).
// Each Stripe webhook endpoint has its own signing secret.
const STRIPE_WEBHOOK_SECRET     = Deno.env.get("STRIPE_PROPOSAL_WEBHOOK_SECRET")!;
const STORAGE_BUCKET            = "proposals";

const FROM_ADDRESS = "Sat Lally <sat@itsadecline.com>";
const OPERATOR_BCC = "sat@itsadecline.com";

// Proposal fee, in minor units (£295.00 = 29500p). Events with a different
// amount_total are silently acknowledged so this function leaves your
// booking webhook unaffected.
const PROPOSAL_FEE_MINOR = 29500;
const PROPOSAL_CURRENCY  = "gbp";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing stripe-signature", { status: 400 });

  const rawBody = await req.text();
  const ok = await verifyStripeSignature(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response("Invalid signature", { status: 400 });

  const event = JSON.parse(rawBody);
  if (event.type !== "checkout.session.completed") {
    return json({ received: true, handled: false }, 200);
  }

  const session = event.data.object;
  const customerEmail = (
    session.customer_details?.email || session.customer_email || ""
  ).toLowerCase();
  if (!customerEmail) return json({ error: "No customer email on session" }, 400);

  const amountMinor = session.amount_total ?? 0;
  const currency = (session.currency ?? "gbp").toLowerCase();

  // Skip non-proposal payments silently — booking checkouts fire the same event.
  if (amountMinor !== PROPOSAL_FEE_MINOR || currency !== PROPOSAL_CURRENCY) {
    return json({ received: true, handled: false, reason: "not_proposal_fee" }, 200);
  }

  const currencyUpper = currency.toUpperCase();
  const amountFormatted = formatAmount(amountMinor, currencyUpper);

  try {
    // 1. Find the matching signed proposal
    const { data: proposal, error: queryError } = await supabase
      .from("proposals")
      .select("*")
      .eq("client_email", customerEmail)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (queryError) throw queryError;
    if (!proposal) {
      console.warn(`[proposal-payment-complete] No proposal for ${customerEmail}`);
      await notifyOperatorOrphanPayment(customerEmail, session.id, amountFormatted);
      return json({ received: true, handled: false, reason: "no_proposal" }, 200);
    }

    // 2. Fetch the signed PDF from Supabase Storage (best-effort).
    let pdfBase64: string | null = null;
    const pdfFilename = `${proposal.proposal_name}_Signed.pdf`;
    try {
      if (proposal.storage_path) {
        const { data, error } = await supabase
          .storage
          .from(STORAGE_BUCKET)
          .download(proposal.storage_path);
        if (error) throw error;
        if (data) {
          const bytes = new Uint8Array(await data.arrayBuffer());
          pdfBase64 = bytesToBase64(bytes);
        }
      }
    } catch (e) {
      console.error("[proposal-payment-complete] Storage fetch failed:", e);
    }

    // 3. Send consolidated email
    const emailOk = await sendConsolidatedEmail({
      to: customerEmail,
      clientName: proposal.client_name,
      proposalName: proposal.proposal_name,
      dateSigned: proposal.date_signed,
      amountPaid: amountFormatted,
      stripeSessionId: session.id,
      pdfBase64,
      pdfFilename,
    });

    // 4. Mark paid (last — so if anything above fails, status stays 'signed'
    //    and a Stripe retry can complete the flow).
    const { error: updateError } = await supabase
      .from("proposals")
      .update({
        status: "paid",
        stripe_session_id: session.id,
        amount_paid_minor: amountMinor,
        amount_currency: currencyUpper,
      })
      .eq("id", proposal.id);

    if (updateError) console.error("[proposal-payment-complete] update failed:", updateError);

    return json({
      received: true,
      handled: true,
      email_sent: emailOk,
      pdf_attached: pdfBase64 !== null,
    }, 200);
  } catch (e) {
    console.error("[proposal-payment-complete] failed:", e);
    return json({ error: (e as Error).message ?? "Internal error" }, 500);
  }
});

// -----------------------------------------------------------------------------
// Stripe signature verification
// -----------------------------------------------------------------------------
async function verifyStripeSignature(body: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=")),
  ) as Record<string, string>;
  const timestamp = parts["t"];
  const given = parts["v1"];
  if (!timestamp || !given) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

// -----------------------------------------------------------------------------
// Resend email with PDF attachment
// -----------------------------------------------------------------------------
async function sendConsolidatedEmail(p: {
  to: string;
  clientName: string;
  proposalName: string;
  dateSigned: string;
  amountPaid: string;
  stripeSessionId: string;
  pdfBase64: string | null;
  pdfFilename: string;
}): Promise<boolean> {
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;color:#1f2937;">
  <h1 style="color:#1a2332;border-bottom:2px solid #f59e0b;padding-bottom:12px;">Payment received — proposal confirmed</h1>
  <p>Dear ${esc(p.clientName)},</p>
  <p>Thank you. Your signed proposal and payment have been received. The fully countersigned PDF is attached to this email for your records.</p>

  <h2 style="color:#1a2332;font-size:16px;margin-top:28px;">Receipt</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr><td style="padding:6px 0;color:#6b7280;">Proposal</td><td style="padding:6px 0;">${esc(p.proposalName)}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Signed</td>  <td style="padding:6px 0;">${esc(p.dateSigned)}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Amount</td>  <td style="padding:6px 0;"><strong>${esc(p.amountPaid)}</strong></td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Paid</td>    <td style="padding:6px 0;">${esc(today)}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Reference</td><td style="padding:6px 0;font-family:ui-monospace,monospace;font-size:12px;">${esc(p.stripeSessionId)}</td></tr>
  </table>

  <h2 style="color:#1a2332;font-size:16px;margin-top:28px;">Next steps</h2>
  <p>We'll review your application and be in touch within two business days. If anything's needed in the meantime, reply to this email or contact sat@itsadecline.com.</p>

  <p style="margin-top:32px;">Best regards,<br><strong>Sat Lally</strong><br>itsadecline.com</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin-top:32px;">
  <p style="font-size:12px;color:#6b7280;">This email also serves as your receipt for the proposal fee.</p>
</div>`;

  const body: Record<string, unknown> = {
    from: FROM_ADDRESS,
    to: [p.to],
    bcc: [OPERATOR_BCC],
    subject: `Payment confirmed — ${p.proposalName}`,
    html,
  };

  if (p.pdfBase64) {
    body.attachments = [{
      filename: p.pdfFilename.endsWith(".pdf") ? p.pdfFilename : `${p.pdfFilename}.pdf`,
      content: p.pdfBase64,
    }];
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error("[Resend] failed:", res.status, await res.text());
    return false;
  }
  return true;
}

async function notifyOperatorOrphanPayment(
  email: string, sessionId: string, amount: string,
): Promise<void> {
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [OPERATOR_BCC],
        subject: `[itsadecline] Orphan payment — no matching proposal`,
        html: `<p>Stripe payment received but no signed proposal was found for <strong>${esc(email)}</strong>.</p>
               <p>Amount: ${esc(amount)}<br>Session: <code>${esc(sessionId)}</code></p>
               <p>Investigate in Stripe + Supabase and reconcile manually.</p>`,
      }),
    });
  } catch (e) {
    console.error("operator notify failed:", e);
  }
}

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------
function formatAmount(minor: number, currency: string): string {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
