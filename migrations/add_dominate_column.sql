-- Migration: Add is_dominate column to domains table
-- Flags domains that belong to Dominate package clients. Kept separate from
-- category so a site can be both e.g. "Live Website" and Dominate.

ALTER TABLE domains
ADD COLUMN IF NOT EXISTS is_dominate BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN domains.is_dominate IS 'True when the domain belongs to a Dominate package client';
