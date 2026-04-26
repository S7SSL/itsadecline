#!/usr/bin/env bash
# Rotate a single Supabase secret without re-typing the others.
#
# Usage:
#   ./scripts/rotate-secret.sh                   # prompts for secret name
#   ./scripts/rotate-secret.sh STRIPE_SECRET_KEY # pre-select the secret
#
# The new value is read silently (won't echo to your terminal or shell history).
set -euo pipefail

PROJECT_REF="uavjeywctezxcchoyboz"

NAME="${1:-}"

if [[ -z "$NAME" ]]; then
  echo "Common secrets you might be rotating:"
  echo "  1) STRIPE_SECRET_KEY              (Stripe API key)"
  echo "  2) STRIPE_WEBHOOK_SECRET          (existing booking webhook signing secret)"
  echo "  3) STRIPE_PROPOSAL_WEBHOOK_SECRET (proposal webhook signing secret)"
  echo "  4) RESEND_API_KEY                 (Resend email API key)"
  echo "  5) other (type the name yourself)"
  echo
  read -rp "Pick a number (or paste a secret name): " choice
  case "$choice" in
    1) NAME="STRIPE_SECRET_KEY" ;;
    2) NAME="STRIPE_WEBHOOK_SECRET" ;;
    3) NAME="STRIPE_PROPOSAL_WEBHOOK_SECRET" ;;
    4) NAME="RESEND_API_KEY" ;;
    5) read -rp "Secret name: " NAME ;;
    *) NAME="$choice" ;;
  esac
fi

if [[ -z "$NAME" ]]; then
  echo "No secret name given. Aborting." >&2
  exit 1
fi

echo
echo "Rotating: $NAME"
echo "Project:  $PROJECT_REF"
echo

# Read silently — value won't appear on screen or in shell history.
read -rsp "Paste new value (input hidden, then press Enter): " VALUE
echo
echo

if [[ -z "$VALUE" ]]; then
  echo "Empty value. Aborting." >&2
  exit 1
fi

# Sanity sniff so a wrong-paste is caught before it hits the secret store.
case "$NAME" in
  STRIPE_SECRET_KEY)
    [[ "$VALUE" =~ ^sk_(live|test)_ ]] || {
      echo "Warning: value doesn't look like a Stripe secret key (sk_live_… / sk_test_…)." >&2
      read -rp "Continue anyway? [y/N] " ok
      [[ "$ok" =~ ^[Yy]$ ]] || exit 1
    } ;;
  STRIPE_WEBHOOK_SECRET|STRIPE_PROPOSAL_WEBHOOK_SECRET)
    [[ "$VALUE" =~ ^whsec_ ]] || {
      echo "Warning: value doesn't look like a Stripe webhook signing secret (whsec_…)." >&2
      read -rp "Continue anyway? [y/N] " ok
      [[ "$ok" =~ ^[Yy]$ ]] || exit 1
    } ;;
  RESEND_API_KEY)
    [[ "$VALUE" =~ ^re_ ]] || {
      echo "Warning: value doesn't look like a Resend API key (re_…)." >&2
      read -rp "Continue anyway? [y/N] " ok
      [[ "$ok" =~ ^[Yy]$ ]] || exit 1
    } ;;
esac

# `supabase secrets set` reads from env when given KEY=VALUE pairs;
# we pass on the command line to avoid touching shell history files.
# Disable history just in case.
set +o history 2>/dev/null || true

supabase secrets set "${NAME}=${VALUE}" --project-ref "$PROJECT_REF"

# Re-enable for cleanliness.
set -o history 2>/dev/null || true

echo
echo "Done. New value for ${NAME} is now live in Supabase."
echo "Edge Functions will pick it up on their next cold start (typically <1 min)."
