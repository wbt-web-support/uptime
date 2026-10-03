-- Migration: funnel test columns. Adds everything the AI funnel test stores, so it
-- also fixes a funnels table created from the first version of add_funnels_table.sql
-- (which only had the page-check columns). Safe to run more than once.
--
-- test_status stays the overall result and test_results holds each device's:
-- {"desktop": {status, failure, steps, tracking_ok, report_file}, "mobile": {...}}
-- Run this in the Supabase SQL Editor.

ALTER TABLE funnels
ADD COLUMN IF NOT EXISTS test_status TEXT, -- 'running' | 'passed' | 'failed' | 'error'; NULL until first tested
ADD COLUMN IF NOT EXISTS test_run_id TEXT, -- funnel-tester batchId while running
ADD COLUMN IF NOT EXISTS test_failure TEXT,
ADD COLUMN IF NOT EXISTS test_steps INTEGER,
ADD COLUMN IF NOT EXISTS test_tracking_ok BOOLEAN,
ADD COLUMN IF NOT EXISTS test_report_file TEXT,
ADD COLUMN IF NOT EXISTS test_started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS test_finished_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS test_results JSONB;
