-- Migration: Funnel pages to test, kept separate from the domains table.
-- Each row is one funnel URL, optionally linked to the client's domain, with the
-- result of its latest uptime check and latest funnel test stored on the row.
-- Run this in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS funnels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  domain_id UUID REFERENCES domains(id) ON DELETE SET NULL, -- client the funnel belongs to
  last_status BOOLEAN, -- NULL until first checked
  last_status_code INTEGER,
  last_response_time INTEGER, -- ms
  last_error TEXT,
  last_checked_at TIMESTAMPTZ,
  -- Latest AI funnel walk from the funnel-tester backend
  test_status TEXT, -- 'running' | 'passed' | 'failed' | 'error'; NULL until first tested
  test_run_id TEXT, -- funnel-tester runId while running
  test_failure TEXT, -- why the walk did not complete
  test_steps INTEGER,
  test_tracking_ok BOOLEAN, -- GTM or gtag present on every step
  test_report_file TEXT, -- report file name on the funnel-tester backend
  test_started_at TIMESTAMPTZ,
  test_finished_at TIMESTAMPTZ,
  test_results JSONB, -- per-device results: {"desktop": {...}, "mobile": {...}}
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funnels_domain_id ON funnels(domain_id);

ALTER TABLE funnels ENABLE ROW LEVEL SECURITY;

-- Funnels are internal: only signed-in users can see or change them
CREATE POLICY funnels_authenticated_all ON funnels
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
