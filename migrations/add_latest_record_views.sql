-- Latest-record views for the monitoring history tables.
--
-- WHY THIS EXISTS
--
-- The dashboard only ever wants the newest row per domain, but it was asking for
-- the whole table ordered by checked_at and keeping the first row it saw for each
-- domain. PostgREST caps every response at 1000 rows, so that pattern silently
-- truncates: domain_expiry holds ~21,000 rows, the newest 1000 covered only 123 of
-- 187 domains, and the other 64 rendered as "Unknown" despite having data.
--
-- It is a silent failure. Nothing errors, the column just goes blank, and it gets
-- worse every time the cron writes more history.
--
-- DISTINCT ON returns exactly one row per domain in a single query, so the result
-- is ~187 rows instead of 21,000 and the cap can never be reached.
--
-- security_invoker = true makes the view run with the CALLER's permissions, so the
-- existing public-read RLS policies on the base tables still apply. Without it a
-- view runs as its owner and would quietly bypass RLS.
--
-- Idempotent: safe to re-run.


-- ---------- indexes ----------
-- DISTINCT ON (domain_id) ORDER BY domain_id, checked_at DESC is only fast with a
-- matching composite index; without it Postgres sorts the entire table every call.

create index if not exists uptime_logs_domain_checked_idx
  on uptime_logs (domain_id, checked_at desc);

create index if not exists ssl_info_domain_checked_idx
  on ssl_info (domain_id, checked_at desc);

create index if not exists domain_expiry_domain_checked_idx
  on domain_expiry (domain_id, checked_at desc);

create index if not exists ip_records_domain_checked_idx
  on ip_records (domain_id, checked_at desc);


-- ---------- views ----------
-- The ORDER BY must lead with domain_id to match DISTINCT ON, then checked_at desc
-- to pick the newest within each domain. Reversing those two returns the wrong row.

create or replace view latest_uptime_logs
  with (security_invoker = true) as
  select distinct on (domain_id) *
  from uptime_logs
  order by domain_id, checked_at desc;

create or replace view latest_ssl_info
  with (security_invoker = true) as
  select distinct on (domain_id) *
  from ssl_info
  order by domain_id, checked_at desc;

create or replace view latest_domain_expiry
  with (security_invoker = true) as
  select distinct on (domain_id) *
  from domain_expiry
  order by domain_id, checked_at desc;

create or replace view latest_ip_records
  with (security_invoker = true) as
  select distinct on (domain_id) *
  from ip_records
  order by domain_id, checked_at desc;


-- ---------- grants ----------
-- Matches the base tables, which all carry a public-read policy. RLS on those
-- tables still decides what is actually visible, because of security_invoker.

grant select on latest_uptime_logs   to anon, authenticated;
grant select on latest_ssl_info      to anon, authenticated;
grant select on latest_domain_expiry to anon, authenticated;
grant select on latest_ip_records    to anon, authenticated;
