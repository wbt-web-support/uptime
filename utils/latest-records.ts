/**
 * Newest history row per domain.
 *
 * The dashboard used to read a whole history table ordered by checked_at and keep
 * the first row it saw for each domain. PostgREST caps every response at 1000 rows,
 * so that silently truncated: domain_expiry holds ~21,000 rows, the newest 1000
 * covered only 123 of 187 domains, and the rest rendered as "Unknown" while their
 * data sat in the table. Nothing errored. The column just went blank, and it got
 * worse with every cron run.
 *
 * Used by both the admin API route (server client) and the public dashboard
 * (browser client), so the two surfaces cannot drift apart.
 */

export type HistoryTable = "uptime_logs" | "ssl_info" | "domain_expiry" | "ip_records";

/** Created by migrations/add_latest_record_views.sql. */
const LATEST_VIEW: Record<HistoryTable, string> = {
  uptime_logs: "latest_uptime_logs",
  ssl_info: "latest_ssl_info",
  domain_expiry: "latest_domain_expiry",
  ip_records: "latest_ip_records",
};

/** How many per-domain lookups to have in flight at once on the fallback path. */
const FALLBACK_BATCH = 25;

/** Rows arrive newest first, so the first one seen for a domain is the current one. */
function indexByDomain(rows: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const row of rows) {
    if (!map.has(row.domain_id)) map.set(row.domain_id, row);
  }
  return map;
}

/**
 * Returns domain_id -> newest row, for every domain that has one.
 *
 * Prefers the DISTINCT ON view, which returns one row per domain in a single query
 * and therefore cannot hit the row cap. If the view is missing (the migration has
 * not been applied yet) it falls back to the capped bulk read plus a targeted
 * lookup for each domain that read missed. The fallback is slower but correct,
 * so deploying this before running the SQL still fixes the blank columns.
 */
export async function fetchLatestPerDomain(
  supabase: any,
  table: HistoryTable,
  domainIds: string[],
): Promise<Map<string, any>> {
  if (domainIds.length === 0) return new Map();

  // Fast path. The view is already one row per domain, so no domain_id filter is
  // needed and the result stays far below the cap.
  const { data: viewRows, error: viewError } = await supabase
    .from(LATEST_VIEW[table])
    .select("*");

  if (!viewError && viewRows) return indexByDomain(viewRows);

  console.warn(
    `[latest-records] ${LATEST_VIEW[table]} unavailable, using fallback. ` +
      `Run migrations/add_latest_record_views.sql. (${viewError?.message ?? "no rows"})`,
  );

  // Fallback, part one: the capped bulk read. Covers whichever domains have been
  // written to most recently, which is most of them.
  const { data: bulk, error: bulkError } = await supabase
    .from(table)
    .select("*")
    .order("checked_at", { ascending: false });

  if (bulkError) throw bulkError;
  const map = indexByDomain(bulk ?? []);

  // Fallback, part two: whatever the cap cut off, fetched one domain at a time.
  const missing = domainIds.filter((id) => !map.has(id));

  for (let i = 0; i < missing.length; i += FALLBACK_BATCH) {
    const batch = missing.slice(i, i + FALLBACK_BATCH);
    const results = await Promise.all(
      batch.map((id) =>
        supabase
          .from(table)
          .select("*")
          .eq("domain_id", id)
          .order("checked_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    );
    for (const { data } of results) {
      if (data) map.set(data.domain_id, data);
    }
  }

  return map;
}
