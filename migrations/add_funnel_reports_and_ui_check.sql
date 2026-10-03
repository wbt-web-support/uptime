-- Migration: full funnel reports in the database, and the UI check.
-- Safe to run more than once. Also adds the funnel test columns, so it fixes a
-- funnels table created from the first version of add_funnels_table.sql.
-- Run this in the Supabase SQL Editor.

-- Funnel test (AI walk on desktop + mobile)
ALTER TABLE funnels
ADD COLUMN IF NOT EXISTS test_status TEXT, -- 'running' | 'passed' | 'failed' | 'error'; NULL until first tested
ADD COLUMN IF NOT EXISTS test_run_id TEXT, -- funnel-tester batchId while running
ADD COLUMN IF NOT EXISTS test_failure TEXT,
ADD COLUMN IF NOT EXISTS test_steps INTEGER,
ADD COLUMN IF NOT EXISTS test_tracking_ok BOOLEAN,
ADD COLUMN IF NOT EXISTS test_report_file TEXT,
ADD COLUMN IF NOT EXISTS test_started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS test_finished_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS test_results JSONB; -- {"desktop": {...}, "mobile": {...}}

-- UI check (loads the page, clicks every quote button, looks for visual problems;
-- submits no forms)
ALTER TABLE funnels
ADD COLUMN IF NOT EXISTS ui_status TEXT, -- 'running' | 'ok' | 'issues' | 'error'; NULL until first checked
ADD COLUMN IF NOT EXISTS ui_run_id TEXT,
ADD COLUMN IF NOT EXISTS ui_results JSONB, -- {"desktop": {...}, "mobile": {...}}
ADD COLUMN IF NOT EXISTS ui_started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS ui_checked_at TIMESTAMPTZ;

-- Full reports, copied from the funnel tester when a run finishes. The tester keeps
-- them as files on its own disk, which a redeploy can wipe; screenshots stay there.
CREATE TABLE IF NOT EXISTS funnel_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  funnel_id UUID REFERENCES funnels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- 'test' | 'ui'
  viewport TEXT NOT NULL, -- 'desktop' | 'mobile'
  status TEXT, -- test: passed/failed/error, ui: ok/issues/error
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funnel_reports_funnel
  ON funnel_reports(funnel_id, kind, viewport, created_at DESC);

ALTER TABLE funnel_reports ENABLE ROW LEVEL SECURITY;

-- Internal like funnels: only signed-in users
DROP POLICY IF EXISTS funnel_reports_authenticated_all ON funnel_reports;
CREATE POLICY funnel_reports_authenticated_all ON funnel_reports
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
