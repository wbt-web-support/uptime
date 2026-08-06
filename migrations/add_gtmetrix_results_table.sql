-- Migration: GTmetrix on-demand test results. Append-only history — every run
-- inserts a new row, so older runs stay visible as records.
-- Run this in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS gtmetrix_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID REFERENCES domains(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  location TEXT, -- GTmetrix location id (default '2' = London, UK)
  gtmetrix_grade TEXT,
  performance_score INTEGER, -- NULL while running
  structure_score INTEGER,
  first_contentful_paint NUMERIC,
  largest_contentful_paint NUMERIC,
  total_blocking_time NUMERIC,
  cumulative_layout_shift NUMERIC,
  speed_index NUMERIC,
  time_to_interactive NUMERIC,
  onload_time NUMERIC,
  fully_loaded_time NUMERIC,
  page_bytes BIGINT,
  page_requests INTEGER,
  report_url TEXT, -- shareable GTmetrix report link
  error TEXT, -- set when the test failed
  raw_data JSONB,
  tested_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gtmetrix_results_domain_id ON gtmetrix_results(domain_id, tested_at DESC);

ALTER TABLE gtmetrix_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY gtmetrix_results_authenticated_write ON gtmetrix_results
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY gtmetrix_results_public_read ON gtmetrix_results
    FOR SELECT TO anon, authenticated USING (true);
