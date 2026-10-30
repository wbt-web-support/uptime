-- Lets a funnel be switched off for testing (e.g. test "Boiler" but not "Boiler Repair").
-- Switched-off funnels are skipped by Run test, Test all, Test next 5 sites and the
-- automatic tests. Every existing funnel stays switched on.
ALTER TABLE funnels ADD COLUMN IF NOT EXISTS test_enabled boolean NOT NULL DEFAULT true;
