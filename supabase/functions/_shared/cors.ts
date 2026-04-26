// Shared CORS headers for browser-callable Edge Functions.
// Matches the pattern of the existing lead-intake / create-checkout functions
// which are deployed with --no-verify-jwt and called directly from the static
// GitHub Pages site at itsadecline.com.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function handlePreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}
