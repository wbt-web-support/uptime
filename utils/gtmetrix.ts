import { SupabaseClient } from "@supabase/supabase-js";
import { normalizeUrl } from "./pagespeed";

// GTmetrix API v2.0 client — on-demand tests only (never run from the cron;
// every test costs paid API credits). The API route inserts a "running" history
// row first; this runner starts the test, polls until the test resource
// resolves to a report, and updates that row in place.

const API_BASE = "https://gtmetrix.com/api/2.0";
// GTmetrix location ids: 1=Vancouver, 2=London (UK), 3=Sydney, 4=San Antonio, ...
export const GTMETRIX_LOCATION = process.env.GTMETRIX_LOCATION || "2";

function authHeader(): string {
  const key = process.env.GTMETRIX_API_KEY;
  if (!key) throw new Error("GTMETRIX_API_KEY is not configured");
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

async function gtFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/vnd.api+json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
}

// Remaining API credits, or null if unavailable.
export async function getGTmetrixCredits(): Promise<number | null> {
  try {
    const res = await gtFetch("/status");
    if (!res.ok) return null;
    const json = await res.json();
    const credits = json?.data?.attributes?.api_credits;
    return typeof credits === "number" ? credits : null;
  } catch {
    return null;
  }
}

// Resolve the configured location id to its human name via the account's
// available locations (ids are account-specific per GTmetrix docs). Returns
// null if the id isn't available to this account — the UI surfaces that.
export async function getGTmetrixLocationName(): Promise<string | null> {
  try {
    const res = await gtFetch("/locations");
    if (!res.ok) return null;
    const json = await res.json();
    const match = (json?.data || []).find((l: any) => String(l.id) === GTMETRIX_LOCATION);
    return match?.attributes?.name || null;
  } catch {
    return null;
  }
}

export async function runAndSaveGTmetrix(
  supabase: SupabaseClient,
  resultId: string,
  url: string
): Promise<{ success: boolean; error?: string }> {
  const normalizedUrl = normalizeUrl(url);

  const saveError = async (message: string) => {
    await supabase
      .from("gtmetrix_results")
      .update({ error: message, tested_at: new Date().toISOString() })
      .eq("id", resultId);
    return { success: false, error: message };
  };

  try {
    // Start the test (defaults: Chrome desktop; location defaults to London).
    const startRes = await gtFetch("/tests", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "test",
          attributes: { url: normalizedUrl, location: GTMETRIX_LOCATION },
        },
      }),
    });

    const startJson = await startRes.json().catch(() => null);
    if (!startRes.ok) {
      const msg =
        startJson?.errors?.[0]?.detail ||
        startJson?.errors?.[0]?.title ||
        `GTmetrix API error: ${startRes.status}`;
      return await saveError(msg);
    }

    const testId = startJson?.data?.id;
    if (!testId) return await saveError("GTmetrix did not return a test id");

    // Poll until the test finishes. GTmetrix redirects a finished test to its
    // report resource (fetch follows the redirect), so data.type flips to
    // "report" when done. Tests typically take 30–90s; allow up to 4 min.
    const deadline = Date.now() + 4 * 60 * 1000;
    let report: any = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await gtFetch(`/tests/${testId}`);
      const pollJson = await pollRes.json().catch(() => null);
      if (!pollRes.ok) continue; // transient; keep polling until deadline

      const data = pollJson?.data;
      if (data?.type === "report") {
        report = data;
        break;
      }
      if (data?.attributes?.state === "error") {
        return await saveError(data.attributes.error || "GTmetrix test failed");
      }
    }

    if (!report) return await saveError("GTmetrix test timed out");

    const a = report.attributes || {};
    const { error: dbError } = await supabase
      .from("gtmetrix_results")
      .update({
        gtmetrix_grade: a.gtmetrix_grade ?? null,
        performance_score: a.performance_score ?? null,
        structure_score: a.structure_score ?? null,
        first_contentful_paint: a.first_contentful_paint ?? null,
        largest_contentful_paint: a.largest_contentful_paint ?? null,
        total_blocking_time: a.total_blocking_time ?? null,
        cumulative_layout_shift: a.cumulative_layout_shift ?? null,
        speed_index: a.speed_index ?? null,
        time_to_interactive: a.time_to_interactive ?? null,
        onload_time: a.onload_time ?? null,
        fully_loaded_time: a.fully_loaded_time ?? null,
        page_bytes: a.page_bytes ?? null,
        page_requests: a.page_requests ?? null,
        report_url: report.links?.report_url ?? null,
        error: null,
        raw_data: report,
        tested_at: new Date().toISOString(),
      })
      .eq("id", resultId);
    if (dbError) throw dbError;

    return { success: true };
  } catch (error: any) {
    console.error(`[gtmetrix] Test error for ${normalizedUrl}:`, error?.message || error);
    return await saveError(error?.message || "Unknown error");
  }
}
