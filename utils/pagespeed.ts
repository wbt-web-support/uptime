import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";

// Shared PageSpeed Insights helpers used by the background API route and the
// cron batch runner. Keeping the fetch + parse + save logic in one place means
// the on-demand path and the scheduled path stay in sync.

export type Strategy = "mobile" | "desktop";

// Admin Supabase client for server-side/cron contexts that have no user session.
// Uses the service-role key to bypass RLS. Falls back to the anon key with a
// warning (writes will likely be blocked by RLS until the service key is set).
export function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  if (!serviceKey) {
    console.warn(
      "[pagespeed] SUPABASE_SERVICE_ROLE_KEY is not set — cron writes to pagespeed_results may be blocked by RLS."
    );
  }

  return createSupabaseClient(url, serviceKey || anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function normalizeUrl(url: string): string {
  let normalized = url.trim();
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = `https://${normalized}`;
  }
  return normalized;
}

// The full set of test targets for a domain: the main URL plus every inner page,
// across both strategies. inner_pages may be stored as a JSON string or array.
export function getDomainTargets(domain: any): Array<{ url: string; strategy: Strategy }> {
  let innerPages: string[] = [];
  if (domain.inner_pages) {
    try {
      innerPages = typeof domain.inner_pages === "string" ? JSON.parse(domain.inner_pages) : domain.inner_pages;
      if (!Array.isArray(innerPages)) innerPages = [];
    } catch {
      innerPages = [];
    }
  }

  const urls = [domain.uptime_url, ...innerPages].filter(Boolean).map(normalizeUrl);
  const uniqueUrls = Array.from(new Set(urls));
  const strategies: Strategy[] = ["mobile", "desktop"];

  return uniqueUrls.flatMap((url) => strategies.map((strategy) => ({ url, strategy })));
}

const getScore = (score: number | null | undefined): number | null =>
  score === null || score === undefined ? null : Math.round(score * 100);

export interface PageSpeedRunResult {
  success: boolean;
  performanceScore: number | null;
  error?: string;
}

// Run a single PageSpeed Insights test and upsert the result. Saves an error
// marker (performance_score = -1) on failure so the UI can surface it.
export async function runAndSavePageSpeed(
  supabase: SupabaseClient,
  domainId: string,
  url: string,
  strategy: Strategy
): Promise<PageSpeedRunResult> {
  const normalizedUrl = normalizeUrl(url);

  try {
    new URL(normalizedUrl);
  } catch {
    return { success: false, performanceScore: null, error: `Invalid URL format: ${url}` };
  }

  const apiKey = process.env.PAGESPEED_INSIGHTS_API_KEY;
  if (!apiKey) {
    return { success: false, performanceScore: null, error: "PageSpeed Insights API key not configured" };
  }

  try {
    const pagespeedUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(
      normalizedUrl
    )}&strategy=${strategy}&category=performance&category=accessibility&category=best-practices&category=seo&key=${apiKey}`;

    // PSI flakes under load (429s, transient 500s). One retry with a short
    // backoff recovers the majority of transient failures for both the
    // on-demand path and the cron.
    let response: Response | null = null;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
      try {
        response = await fetch(pagespeedUrl, { cache: "no-store" });
        if (response.ok) break;
        let errorText = "";
        let errorData: any = null;
        try {
          errorText = await response.text();
          try {
            errorData = JSON.parse(errorText);
          } catch {}
        } catch {}
        lastError = new Error(errorData?.error?.message || errorText || `PageSpeed API error: ${response.status}`);
        // Only retry statuses that can succeed on a second try.
        if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError;
        response = null;
      } catch (err: any) {
        if (err === lastError) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        response = null; // network error — retry
      }
    }
    if (!response) throw lastError || new Error("PageSpeed API request failed");

    const apiData = await response.json();
    if (apiData.error) throw new Error(apiData.error.message || "PageSpeed API error");
    if (!apiData.lighthouseResult) throw new Error("Invalid response from PageSpeed API");

    const { categories, audits } = apiData.lighthouseResult;
    if (!categories || !audits) throw new Error("Invalid response structure from PageSpeed API");

    const performanceScore = getScore(categories.performance?.score);

    const resultData = {
      domain_id: domainId,
      url: normalizedUrl,
      strategy,
      performance_score: performanceScore,
      accessibility_score: getScore(categories.accessibility?.score),
      best_practices_score: getScore(categories["best-practices"]?.score),
      seo_score: getScore(categories.seo?.score),
      first_contentful_paint: audits["first-contentful-paint"]?.numericValue ?? null,
      largest_contentful_paint: audits["largest-contentful-paint"]?.numericValue ?? null,
      total_blocking_time: audits["total-blocking-time"]?.numericValue ?? null,
      cumulative_layout_shift: audits["cumulative-layout-shift"]?.numericValue ?? null,
      speed_index: audits["speed-index"]?.numericValue ?? null,
      time_to_interactive: audits["interactive"]?.numericValue ?? null,
      raw_data: apiData,
      tested_at: new Date().toISOString(),
    };

    const { error: saveError } = await supabase
      .from("pagespeed_results")
      .upsert(resultData, { onConflict: "domain_id,url,strategy", ignoreDuplicates: false });

    if (saveError) throw saveError;

    return { success: true, performanceScore };
  } catch (error: any) {
    console.error(`[pagespeed] Test error for ${normalizedUrl} (${strategy}):`, error?.message || error);

    // Persist an error marker so the run is not silently lost.
    try {
      await supabase.from("pagespeed_results").upsert(
        {
          domain_id: domainId,
          url: normalizedUrl,
          strategy,
          performance_score: -1,
          tested_at: new Date().toISOString(),
        },
        { onConflict: "domain_id,url,strategy" }
      );
    } catch (dbError) {
      console.error("[pagespeed] Failed to save error state:", dbError);
    }

    return { success: false, performanceScore: null, error: error?.message || "Unknown error" };
  }
}
