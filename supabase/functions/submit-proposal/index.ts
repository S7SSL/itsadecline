// submit-proposal
// -----------------------------------------------------------------------------
// Called by proposal/index.html when the client hits "Submit Proposal for
// Signing". Generates a signed-record PDF, stores it in the private Supabase
// Storage bucket `proposals`, writes a row into public.proposals with
// status='signed'. No email at this step — Flow 2 sends the consolidated
// email from the payment-complete webhook.
// -----------------------------------------------------------------------------

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { buildSignedProposalPdf } from "../_shared/pdf.ts";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STORAGE_BUCKET            = "proposals";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface SubmitBody {
  signature: string;       // data URL
  email: string;
  dateSigned: string;      // yyyy-mm-dd
  proposalName: string;    // short ref, e.g. "PPQ_Proposal_24022026"
  proposalTitle?: string;  // human title, optional
  clientName: string;
  keyTerms?: Array<{ label: string; value: string }>;
}

serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: SubmitBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const errs = validate(body);
  if (errs.length) return json({ error: "Validation failed", details: errs }, 400);

  const email = body.email.trim().toLowerCase();

  try {
    // 1. Build the signed-record PDF
    const pdfBytes = await buildSignedProposalPdf({
      clientName:      body.clientName,
      proposalName:    body.proposalName,
      proposalTitle:   body.proposalTitle,
      proposalUrl:     "https://itsadecline.com/proposal/",
      dateSigned:      body.dateSigned,
      clientEmail:     email,
      signatureDataUrl: body.signature,
      keyTerms:        body.keyTerms,
    });

    // 2. Upload to Supabase Storage (private bucket).
    // Path layout: proposals/<email>/<date>_<proposalName>_<short-uuid>.pdf
    // Including a uuid handles re-signs without overwriting prior versions.
    const safeEmail = email.replace(/[^a-z0-9.@_-]/g, "_");
    const shortId = crypto.randomUUID().slice(0, 8);
    const storagePath =
      `${safeEmail}/${body.dateSigned}_${body.proposalName}_${shortId}.pdf`;

    const { error: uploadError } = await supabase
      .storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, pdfBytes, {
        contentType: "application/pdf",
        upsert: false,
      });
    if (uploadError) throw uploadError;

    // 3. Insert DB row
    const { data: row, error: dbError } = await supabase
      .from("proposals")
      .insert({
        client_email:     email,
        client_name:      body.clientName,
        proposal_name:    body.proposalName,
        date_signed:      body.dateSigned,
        signature_image:  body.signature,
        storage_path:     storagePath,
        status:           "signed",
      })
      .select("id")
      .single();

    if (dbError) throw dbError;

    return json({
      success: true,
      proposal_id: row?.id,
      storage_path: storagePath,
    }, 200);
  } catch (e) {
    console.error("[submit-proposal] failed:", e);
    return json({ error: (e as Error).message ?? "Internal error" }, 500);
  }
});

function validate(b: SubmitBody): string[] {
  const errs: string[] = [];
  if (!b?.signature || !b.signature.startsWith("data:image/")) {
    errs.push("signature must be a data URL image");
  }
  if (!b?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) {
    errs.push("email must be a valid address");
  }
  if (!b?.dateSigned || !/^\d{4}-\d{2}-\d{2}$/.test(b.dateSigned)) {
    errs.push("dateSigned must be yyyy-mm-dd");
  }
  if (!b?.proposalName) errs.push("proposalName required");
  if (!b?.clientName) errs.push("clientName required");
  return errs;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
