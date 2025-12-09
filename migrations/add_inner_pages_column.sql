-- Migration: Add inner_pages column to domains table
-- This column stores an array of URLs (inner pages) for speed testing

-- Add the inner_pages column as JSONB (or TEXT[] if you prefer array type)
ALTER TABLE domains 
ADD COLUMN IF NOT EXISTS inner_pages JSONB DEFAULT '[]'::jsonb;

-- Alternative: If you prefer using TEXT array instead of JSONB, use this:
-- ALTER TABLE domains 
-- ADD COLUMN IF NOT EXISTS inner_pages TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Add a comment to document the column
COMMENT ON COLUMN domains.inner_pages IS 'Array of additional URLs (inner pages) for speed testing, stored as JSON array';

