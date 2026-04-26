-- Proposals table: one row per signed proposal.
-- Flow: submit-proposal writes a row with status='signed' and a Google Drive file id;
-- proposal-payment-complete (Stripe webhook) updates the row to status='paid'.

create table if not exists public.proposals (
  id                    bigint generated always as identity primary key,
  client_email          text        not null,
  client_name           text        not null,
  proposal_name         text        not null,
  date_signed           date        not null,
  signature_image       text        not null,   -- base64 data URL, as received
  google_drive_file_id  text,
  stripe_session_id     text,
  status                text        not null default 'signed',  -- signed | paid | failed
  amount_paid_minor     bigint,                 -- populated on payment
  amount_currency       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_proposals_email  on public.proposals (lower(client_email));
create index if not exists idx_proposals_status on public.proposals (status);
create index if not exists idx_proposals_created on public.proposals (created_at desc);

-- Row-level security: only service role (used by Edge Functions) can read/write.
-- Public anon role has no access.
alter table public.proposals enable row level security;

-- No public policies — service role bypasses RLS so functions work unchanged.

-- Touch updated_at on every UPDATE.
create or replace function public.tg_proposals_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists proposals_touch_updated_at on public.proposals;
create trigger proposals_touch_updated_at
  before update on public.proposals
  for each row execute function public.tg_proposals_touch_updated_at();
