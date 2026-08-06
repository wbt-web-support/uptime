import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient, normalizeUrl } from "@/utils/pagespeed";
import { getGTmetrixCredits, runAndSaveGTmetrix, GTMETRIX_LOCATION } from "@/utils/gtmetrix";

// On-demand GTmetrix test endpoint. One URL per request — GTmetrix credits are
// paid, so this is deliberately never called in bulk or from the cron. Each run
// inserts a new history row (older runs remain as records).

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!process.env.GTMETRIX_API_KEY) {
      return NextResponse.json(
        { error: "GTmetrix API key not configured. Set GTMETRIX_API_KEY." },
        { status: 500 }
      );
    }

    const { domainId, url } = await request.json();
    if (!domainId || !url) {
      return NextResponse.json({ error: "Domain ID and URL are required" }, { status: 400 });
    }

    const normalizedUrl = normalizeUrl(url);
    const admin = createAdminClient();

    // Insert the "running" history row (performance_score null + no error).
    const { data: inserted, error: insertError } = await admin
      .from("gtmetrix_results")
      .insert({
        domain_id: domainId,
        url: normalizedUrl,
        location: GTMETRIX_LOCATION,
        performance_score: null,
        error: null,
        tested_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      console.error("Error creating GTmetrix result row:", insertError);
      return NextResponse.json({ error: "Failed to queue test" }, { status: 500 });
    }

    // Run after the response — same keep-alive pattern as the PSI runner.
    after(async () => {
      try {
        await runAndSaveGTmetrix(admin, inserted.id, normalizedUrl);
      } catch (err) {
        console.error(`GTmetrix test failed for ${normalizedUrl}:`, err);
      }
    });

    return NextResponse.json({
      success: true,
      message: "GTmetrix test started",
      resultId: inserted.id,
      url: normalizedUrl,
    });
  } catch (error: any) {
    console.error("GTmetrix API route error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}

// GET: remaining API credits (shown in the UI so the 50-test budget is visible).
export async function GET() {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.GTMETRIX_API_KEY) {
    return NextResponse.json({ configured: false, credits: null });
  }
  const credits = await getGTmetrixCredits();
  return NextResponse.json({ configured: true, credits });
}
