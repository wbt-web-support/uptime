import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

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
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

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
    runPageSpeedTestInBackground(domainId, normalizedUrl, strategy).catch(err => {
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

// Background function to run PageSpeed test
async function runPageSpeedTestInBackground(domainId: string, url: string, strategy: 'mobile' | 'desktop') {
  const supabase = await createClient();
  
  try {
    // Normalize URL
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    // Validate URL
    try {
      new URL(normalizedUrl);
    } catch {
      throw new Error(`Invalid URL format: ${url}`);
    }

    const apiKey = process.env.PAGESPEED_INSIGHTS_API_KEY;
    if (!apiKey) {
      throw new Error("PageSpeed Insights API key not configured");
    }

    const pagespeedUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(normalizedUrl)}&strategy=${strategy}&key=${apiKey}`;
    
    const response = await fetch(pagespeedUrl, {
      cache: 'no-store',
    });

    if (!response.ok) {
      let errorText = '';
      let errorData = null;
      
      try {
        errorText = await response.text();
        try {
          errorData = JSON.parse(errorText);
        } catch {}
      } catch {}

      const errorMessage = errorData?.error?.message || errorText || `PageSpeed API error: ${response.status}`;
      throw new Error(errorMessage);
    }

    const apiData = await response.json();

    if (apiData.error) {
      throw new Error(apiData.error.message || 'PageSpeed API error');
    }

    if (!apiData.lighthouseResult) {
      throw new Error('Invalid response from PageSpeed API');
    }

    const lighthouseResult = apiData.lighthouseResult;
    const categories = lighthouseResult.categories;
    const audits = lighthouseResult.audits;

    if (!categories || !audits) {
      throw new Error('Invalid response structure from PageSpeed API');
    }

    const performanceScore = Math.round(categories.performance?.score * 100 || 0);
    const accessibilityScore = Math.round(categories.accessibility?.score * 100 || 0);
    const bestPracticesScore = Math.round(categories['best-practices']?.score * 100 || 0);
    const seoScore = Math.round(categories.seo?.score * 100 || 0);

    const firstContentfulPaint = audits['first-contentful-paint']?.numericValue || null;
    const largestContentfulPaint = audits['largest-contentful-paint']?.numericValue || null;
    const totalBlockingTime = audits['total-blocking-time']?.numericValue || null;
    const cumulativeLayoutShift = audits['cumulative-layout-shift']?.numericValue || null;
    const speedIndex = audits['speed-index']?.numericValue || null;
    const timeToInteractive = audits['interactive']?.numericValue || null;

    // Save results to database
    const resultData = {
      domain_id: domainId,
      url: normalizedUrl,
      strategy: strategy,
      performance_score: performanceScore,
      accessibility_score: accessibilityScore,
      best_practices_score: bestPracticesScore,
      seo_score: seoScore,
      first_contentful_paint: firstContentfulPaint,
      largest_contentful_paint: largestContentfulPaint,
      total_blocking_time: totalBlockingTime,
      cumulative_layout_shift: cumulativeLayoutShift,
      speed_index: speedIndex,
      time_to_interactive: timeToInteractive,
      raw_data: apiData,
    };

    console.log(`💾 Attempting to save result for ${normalizedUrl}...`, {
      domain_id: domainId,
      url: normalizedUrl,
      strategy,
      performance_score: performanceScore
    });

    const { data: savedData, error: saveError } = await supabase
      .from("pagespeed_results")
      .upsert(resultData, {
        onConflict: 'domain_id,url,strategy',
        ignoreDuplicates: false,
      })
      .select();

    if (saveError) {
      console.error(`❌ Error saving PageSpeed result for ${normalizedUrl}:`, saveError);
      console.error('Error details:', JSON.stringify(saveError, null, 2));
      console.error('Result data that failed to save:', JSON.stringify(resultData, null, 2));
      
      // Try to check if table exists
      const { error: tableCheckError } = await supabase
        .from("pagespeed_results")
        .select("id")
        .limit(1);
      
      if (tableCheckError) {
        console.error('❌ Table check failed - table may not exist:', tableCheckError);
        console.error('⚠️ Please run the migration: migrations/add_pagespeed_results_table.sql');
      }
      
      throw saveError;
    }

    if (!savedData || savedData.length === 0) {
      console.warn(`⚠️ No data returned after upsert for ${normalizedUrl}`);
    } else {
      console.log(`✅ Background PageSpeed test completed and saved for ${normalizedUrl}`, {
        performance_score: performanceScore,
        saved: true,
        record_id: savedData[0]?.id,
        record_count: savedData.length
      });
    }

  } catch (error: any) {
    console.error(`Background PageSpeed test error for ${url}:`, error);
    
    // Normalize URL for error update
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = `https://${normalizedUrl}`;
    }
    
    // Save error state to database
    try {
      await supabase
        .from("pagespeed_results")
        .upsert({
          domain_id: domainId,
          url: normalizedUrl,
          strategy: strategy,
          performance_score: -1, // Use -1 to indicate error
          tested_at: new Date().toISOString(),
        }, {
          onConflict: 'domain_id,url,strategy',
        });
    } catch (dbError) {
      console.error("Error saving error state to database:", dbError);
    }
  }
}

