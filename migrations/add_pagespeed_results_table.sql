-- Migration: Add pagespeed_results table to store PageSpeed Insights data
-- This table stores the results from Google PageSpeed Insights API

CREATE TABLE IF NOT EXISTS pagespeed_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID REFERENCES domains(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  strategy TEXT NOT NULL, -- 'mobile' or 'desktop'
  performance_score INTEGER, -- NULL means test is queued/running, -1 means error
  accessibility_score INTEGER,
  best_practices_score INTEGER,
  seo_score INTEGER,
  first_contentful_paint NUMERIC,
  largest_contentful_paint NUMERIC,
  total_blocking_time NUMERIC,
  cumulative_layout_shift NUMERIC,
  speed_index NUMERIC,
  time_to_interactive NUMERIC,
  raw_data JSONB, -- Store the full API response
  tested_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(domain_id, url, strategy)
);

-- Index for faster queries
CREATE INDEX IF NOT EXISTS idx_pagespeed_results_domain_id ON pagespeed_results(domain_id);
CREATE INDEX IF NOT EXISTS idx_pagespeed_results_url ON pagespeed_results(url);
CREATE INDEX IF NOT EXISTS idx_pagespeed_results_tested_at ON pagespeed_results(tested_at DESC);

-- Add comment to document the table
COMMENT ON TABLE pagespeed_results IS 'Stores PageSpeed Insights API results for domains and their inner pages';

-- Enable Row Level Security (RLS)
ALTER TABLE pagespeed_results ENABLE ROW LEVEL SECURITY;

-- RLS Policies for pagespeed_results table
-- Allow authenticated users to insert/update (for API routes)
CREATE POLICY pagespeed_results_authenticated_write ON pagespeed_results
    FOR ALL 
    TO authenticated 
    USING (true)
    WITH CHECK (true);

-- Anyone can read (for public display)
CREATE POLICY pagespeed_results_public_read ON pagespeed_results
    FOR SELECT
    TO anon, authenticated
    USING (true);

