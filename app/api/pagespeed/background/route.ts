import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { normalizeUrl, runAndSavePageSpeed } from "@/utils/pagespeed";

// Background PageSpeed test endpoint
// Starts the test and returns immediately, test runs in background
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { domainId, url, strategy = 'mobile' } = await request.json();

    if (!domainId || !url) {
      return NextResponse.json({ 
        error: "Domain ID and URL are required" 
      }, { status: 400 });
    }

    if (!['mobile', 'desktop'].includes(strategy)) {
      return NextResponse.json({ 
        error: "Strategy must be 'mobile' or 'desktop'" 
      }, { status: 400 });
    }

    // Normalize URL first to ensure consistency
    const normalizedUrl = normalizeUrl(url);

    // Mark test as queued in database (use normalized URL)
    const { error: queueError } = await supabase
      .from("pagespeed_results")
      .upsert({
        domain_id: domainId,
        url: normalizedUrl, // Use normalized URL consistently
        strategy: strategy,
        performance_score: null,
        accessibility_score: null,
        best_practices_score: null,
        seo_score: null,
        tested_at: new Date().toISOString(),
      }, {
        onConflict: 'domain_id,url,strategy',
      });

    if (queueError) {
      console.error("Error queuing test:", queueError);
    }

    // Start background test (don't await) - pass normalized URL
    runAndSavePageSpeed(supabase as any, domainId, normalizedUrl, strategy).catch(err => {
      console.error(`Background PageSpeed test failed for ${normalizedUrl}:`, err);
    });

    // Return immediately
    return NextResponse.json({
      success: true,
      message: "Test started in background",
      domainId,
      url,
      strategy,
    });

  } catch (error: any) {
    console.error("Background PageSpeed API route error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
