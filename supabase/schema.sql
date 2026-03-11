-- ============================================================
-- itsadecline.com — Supabase Schema
-- Equity Release / 2nd Charge Mortgage Underwriting Pipeline
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- LEADS TABLE (pre-payment enquiries)
-- ============================================================
CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  postcode text,
  property_value numeric,
  mortgage_balance numeric,
  loan_amount numeric,
  tcs_accepted boolean DEFAULT false,
  tcs_timestamp timestamptz,
  signature_data text,
  stripe_session_id text,
  converted_to_case boolean DEFAULT false
);

-- Indexes for common lookups
CREATE INDEX leads_email_idx ON leads (email);
CREATE INDEX leads_created_at_idx ON leads (created_at DESC);
CREATE INDEX leads_converted_idx ON leads (converted_to_case);

-- ============================================================
-- CASES TABLE (post-payment, active pipeline)
-- ============================================================
CREATE TABLE cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  case_ref text UNIQUE NOT NULL,
  lead_id uuid REFERENCES leads(id),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  postcode text,
  property_value numeric,
  mortgage_balance numeric,
  loan_amount numeric,
  ltv_ratio numeric,
  stage text DEFAULT 'RECEIVED' CHECK (stage IN (
    'RECEIVED',
    'HMLR',
    'VALUATION',
    'KYC',
    'LENDER',
    'OFFER',
    'COMPLETED',
    'REFERRED',
    'DECLINED'
  )),
  stripe_payment_id text,
  hmlr_title_number text,
  hmlr_data jsonb,
  zoopla_valuation numeric,
  rightmove_valuation numeric,
  desktop_valuation numeric,
  credas_check_id text,
  credas_status text,
  drive_folder_id text,
  lender_submitted_at timestamptz,
  offer_amount numeric,
  offer_rate numeric,
  offer_term_years integer,
  notes text,
  archived boolean DEFAULT false,
  archive_reason text
);

-- Indexes for common lookups
CREATE INDEX cases_case_ref_idx ON cases (case_ref);
CREATE INDEX cases_email_idx ON cases (email);
CREATE INDEX cases_stage_idx ON cases (stage);
CREATE INDEX cases_created_at_idx ON cases (created_at DESC);
CREATE INDEX cases_archived_idx ON cases (archived);
CREATE INDEX cases_lead_id_idx ON cases (lead_id);

-- ============================================================
-- ROW LEVEL SECURITY (recommended for Supabase)
-- Enable RLS and restrict public access; use service key only
-- ============================================================
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;

-- Allow full access with service role key (used by API functions)
-- Public / anon users have no access
CREATE POLICY "Service role full access on leads"
  ON leads FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on cases"
  ON cases FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- HELPFUL VIEWS
-- ============================================================

-- Active pipeline overview
CREATE VIEW pipeline_overview AS
SELECT
  c.case_ref,
  c.name,
  c.email,
  c.postcode,
  c.stage,
  c.loan_amount,
  c.ltv_ratio,
  c.created_at,
  c.credas_status,
  c.archived
FROM cases c
WHERE c.archived = false
ORDER BY c.created_at DESC;

-- Conversion funnel: leads → cases
CREATE VIEW conversion_funnel AS
SELECT
  COUNT(*) FILTER (WHERE converted_to_case = false AND tcs_accepted = false) AS raw_leads,
  COUNT(*) FILTER (WHERE tcs_accepted = true) AS tcs_accepted,
  COUNT(*) FILTER (WHERE converted_to_case = true) AS converted_to_case
FROM leads;
