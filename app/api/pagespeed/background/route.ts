import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient, normalizeUrl, runAndSavePageSpeed, type Strategy } from "@/utils/pagespeed";

// Background PageSpeed test endpoint.
//
// Responds immediately, then runs the tests via `after()` so the serverless
// function stays alive until they finish. (Previously the test was fired
// without awaiting — on Vercel the function freezes as soon as the response is
// sent, so tests died mid-flight and rows stayed stuck in "queued" forever.)
//
// Accepts either a single `strategy` (legacy) or a `strategies` array so one
// request can cover mobile + desktop.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const VALID: Strategy[] = ["mobile", "desktop"];

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { domainId, url } = body;
    const strategies: Strategy[] = Array.isArray(body.strategies)
      ? body.strategies
      : [body.strategy || "mobile"];

    if (!domainId || !url) {
      return NextResponse.json({ error: "Domain ID and URL are required" }, { status: 400 });
    }
    if (strategies.length === 0 || strategies.some((s) => !VALID.includes(s))) {
      return NextResponse.json({ error: "Strategies must be 'mobile' or 'desktop'" }, { status: 400 });
    }

    const normalizedUrl = normalizeUrl(url);
    // Admin client: the test outlives the request, so don't depend on the
    // request-scoped session client for the writes.
    const admin = createAdminClient();

    // Mark each test as queued (performance_score = null → "running" in the UI).
    for (const strategy of strategies) {
      const { error: queueError } = await admin.from("pagespeed_results").upsert(
        {
          domain_id: domainId,
          url: normalizedUrl,
          strategy,
          performance_score: null,
          accessibility_score: null,
          best_practices_score: null,
          seo_score: null,
          tested_at: new Date().toISOString(),
        },
        { onConflict: "domain_id,url,strategy" }
      );
      if (queueError) console.error("Error queuing test:", queueError);
    }

    // Run after the response is sent; sequential to avoid PSI burst throttling.
    after(async () => {
      for (const strategy of strategies) {
        try {
          await runAndSavePageSpeed(admin, domainId, normalizedUrl, strategy);
        } catch (err) {
          console.error(`Background PageSpeed test failed for ${normalizedUrl} (${strategy}):`, err);
        }
      }
    });

    return NextResponse.json({
      success: true,
      message: "Tests started",
      domainId,
      url: normalizedUrl,
      strategies,
    });
  } catch (error: any) {
    console.error("Background PageSpeed API route error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
