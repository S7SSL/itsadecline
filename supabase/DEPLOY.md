# Proposal signing + payment — deploy checklist

Flow 2 (single consolidated email on payment success). PDFs stored in Supabase Storage. Existing Edge Functions (`lead-intake`, `create-checkout`, `slots`, `book`) are untouched.

What got added:
- `supabase/migrations/20260424120000_create_proposals.sql` — the `proposals` table
- `supabase/migrations/20260424130000_proposals_storage_bucket.sql` — adds `storage_path` column + creates the private `proposals` storage bucket
- `supabase/functions/submit-proposal/` — generates signed-record PDF, uploads to Supabase Storage, inserts row
- `supabase/functions/proposal-payment-complete/` — Stripe webhook handler, downloads PDF from Storage, emails client with PDF attached
- `supabase/functions/_shared/` — pdf-lib PDF builder + CORS helpers
- `proposal/index.html` — email field + submit-then-unlock-payment flow

## Prerequisites

- `supabase` CLI installed (`brew install supabase/tap/supabase`).
- Logged into Supabase (`supabase login`) and linked to the project.

Already-in-place secrets you can leave alone:
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — auto-populated.
- `RESEND_API_KEY` — already set.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — for the existing booking webhook, keep.

What you'll add:
- `STRIPE_PROPOSAL_WEBHOOK_SECRET` — created in step 4 below.

---

## 1. Apply the migrations

From the repo root:

```bash
supabase db push
```

It will list the two pending migrations and ask Y/N. Press Y. This creates the `proposals` table, adds the `storage_path` column, and creates the private `proposals` Storage bucket.

You can verify in Supabase dashboard → Storage → you should see a `proposals` bucket marked **private**.

## 2. Deploy the Edge Functions

```bash
# matches your existing lead-intake pattern — frontend calls without auth header
supabase functions deploy submit-proposal --no-verify-jwt

# webhook receiver — no JWT (Stripe signs the payload instead)
supabase functions deploy proposal-payment-complete --no-verify-jwt
```

Both functions read the `SUPABASE_SERVICE_ROLE_KEY` automatically — they have full access to the `proposals` bucket and the `proposals` table without any extra config.

## 3. Create the Stripe webhook (and capture its secret)

Stripe dashboard → Developers → Webhooks → **Add endpoint**.

- Endpoint URL: `https://uavjeywctezxcchoyboz.supabase.co/functions/v1/proposal-payment-complete`
- Events to send: `checkout.session.completed`
- Save.

After saving, Stripe shows the signing secret (starts `whsec_`). Copy it.

**Don't replace your existing booking webhook** — leave that alone. This is a *second* endpoint. Stripe supports multiple. The proposal handler silently ignores any event whose `amount_total` isn't £295 so bookings won't be mishandled.

## 4. Set the new Stripe secret in Supabase

```bash
supabase secrets set \
  STRIPE_PROPOSAL_WEBHOOK_SECRET="whsec_xxx..." \
  --project-ref uavjeywctezxcchoyboz
```

(Use the secret you just copied from Stripe in step 3.)

## 5. Push the frontend change

```bash
git add .
git commit -m "feat(proposal): server-side signature flow + email+PDF on payment"
git push origin main
```

GitHub Pages picks up the new `proposal/index.html` within ~1 minute.

## 6. Smoke-test before going live

1. Switch the Stripe payment link `buy.stripe.com/bJebIU4rK5w3frp1mN5ZC0i` to test mode (or create a test-mode clone).
2. On itsadecline.com/proposal/: sign, enter your own email, submit.
   - Check Supabase dashboard → Storage → `proposals` bucket — new PDF.
   - Check Supabase table `proposals` — new row, `status='signed'`, `storage_path` set.
3. Click through to Stripe checkout, complete with test card `4242 4242 4242 4242`.
4. Stripe → Webhooks → your new endpoint should show 200 OK.
5. Check your inbox — one email from `sat@itsadecline.com` with the PDF attached. BCC copy too.
6. Check the `proposals` row — `status='paid'`, `stripe_session_id` filled.

If anything fails, tail the function logs:

```bash
supabase functions logs submit-proposal --project-ref uavjeywctezxcchoyboz
supabase functions logs proposal-payment-complete --project-ref uavjeywctezxcchoyboz
```

---

## Where everything lives now

| Asset | Home |
| --- | --- |
| Live frontend | GitHub Pages (`S7SSL/itsadecline` → `main`) |
| Edge Function source | Same GitHub repo (`supabase/functions/`) |
| Signed proposal PDFs | Supabase Storage `proposals/<email>/<date>_<name>_<id>.pdf` |
| Proposal metadata | Supabase `public.proposals` |
| Payment events | Stripe + `proposals.stripe_session_id` |
| Receipt emails | Client inbox + `sat@itsadecline.com` BCC |

GitHub itself is the code backup. Sat's inbox is the durable PDF archive (every signed PDF lands there via BCC). If you later want a separate Storage→GitHub-Releases nightly snapshot, easy to add — but not needed for tonight.
