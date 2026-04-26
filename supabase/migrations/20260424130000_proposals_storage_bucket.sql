-- Switch storage from Google Drive to Supabase Storage.
-- Adds the `storage_path` column on proposals, drops `google_drive_file_id`,
-- and creates a private `proposals` storage bucket.

alter table public.proposals
  add column if not exists storage_path text;

alter table public.proposals
  drop column if exists google_drive_file_id;

-- Create the private bucket. INSERT with on conflict do nothing so re-running
-- the migration is safe.
insert into storage.buckets (id, name, public)
values ('proposals', 'proposals', false)
on conflict (id) do nothing;

-- Service role bypasses storage RLS, so the Edge Functions (which use
-- SUPABASE_SERVICE_ROLE_KEY) can read/write freely. We deliberately do NOT
-- add anon policies — clients should never directly access these PDFs.
