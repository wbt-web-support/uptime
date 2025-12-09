import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

// PageSpeed Insights API endpoint
// Checks database first, then calls API if needed
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

    // Check if we have recent results in database (within last 24 hours)
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);

    const { data: existingResult, error: dbError } = await supabase
      .from("pagespeed_results")
      .select("*")
      .eq("domain_id", domainId)
      .eq("url", url)
      .eq("strategy", strategy)
      .gte("tested_at", oneDayAgo.toISOString())
      .order("tested_at", { ascending: false })
      .limit(1)
      .single();

    // If we have recent data, return it
    if (existingResult && !dbError) {
      return NextResponse.json({
        success: true,
        fromCache: true,
        data: existingResult,
      });
    }

    // No recent data, call PageSpeed Insights API
    const apiKey = process.env.PAGESPEED_INSIGHTS_API_KEY;
    
    if (!apiKey) {
      return NextResponse.json({ 
        error: "PageSpeed Insights API key not configured. Please set PAGESPEED_INSIGHTS_API_KEY environment variable." 
      }, { status: 500 });
    }

    // Validate and normalize URL
    let normalizedUrl = url.trim();
    
    // Ensure URL has protocol
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    // Validate URL format
    try {
      new URL(normalizedUrl);
    } catch (urlError) {
      return NextResponse.json({ 
        error: `Invalid URL format: ${url}`,
        details: "URL must be a valid HTTP or HTTPS URL"
      }, { status: 400 });
    }

    // Request all categories so we can populate scores for performance, accessibility, best-practices, and SEO
    const pagespeedUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(normalizedUrl)}&strategy=${strategy}&category=performance&category=accessibility&category=best-practices&category=seo&key=${apiKey}`;
    
    console.log(`Calling PageSpeed API for: ${normalizedUrl}`);
    
    const response = await fetch(pagespeedUrl, {
      cache: 'no-store',
    });

    if (!response.ok) {
      let errorText = '';
      let errorData = null;
      
      try {
        errorText = await response.text();
        // Try to parse as JSON
        try {
          errorData = JSON.parse(errorText);
        } catch {
          // Not JSON, use as text
        }
      } catch (e) {
        errorText = 'Failed to read error response';
      }

      console.error("PageSpeed API error:", {
        status: response.status,
        statusText: response.statusText,
        url: normalizedUrl,
        errorText,
        errorData
      });

      const errorMessage = errorData?.error?.message || errorText || `PageSpeed API error: ${response.status}`;
      
      return NextResponse.json({ 
        error: errorMessage,
        status: response.status,
        details: errorData || errorText,
        url: normalizedUrl
      }, { status: response.status });
    }

    const apiData = await response.json();

    // Check if API returned an error
    if (apiData.error) {
      console.error("PageSpeed API returned error:", apiData.error);
      return NextResponse.json({ 
        error: apiData.error.message || 'PageSpeed API error',
        details: apiData.error
      }, { status: 400 });
    }

    // Extract relevant metrics
    if (!apiData.lighthouseResult) {
      console.error("PageSpeed API response missing lighthouseResult:", apiData);
      return NextResponse.json({ 
        error: 'Invalid response from PageSpeed API',
        details: 'Missing lighthouseResult in response'
      }, { status: 500 });
    }

    const lighthouseResult = apiData.lighthouseResult;
    const categories = lighthouseResult.categories;
    const audits = lighthouseResult.audits;

    if (!categories || !audits) {
      console.error("PageSpeed API response missing categories or audits:", lighthouseResult);
      return NextResponse.json({ 
        error: 'Invalid response from PageSpeed API',
        details: 'Missing categories or audits in lighthouseResult'
      }, { status: 500 });
    }

    // Log category scores for debugging
    console.log('📊 Category scores from API:', {
      performance: categories.performance?.score,
      accessibility: categories.accessibility?.score,
      'best-practices': categories['best-practices']?.score,
      seo: categories.seo?.score,
      allCategories: Object.keys(categories)
    });

    // Extract scores - convert from 0-1 scale to 0-100, or null if not available
    const getScore = (score: number | null | undefined): number | null => {
      if (score === null || score === undefined) {
        return null;
      }
      return Math.round(score * 100);
    };

    const performanceScore = getScore(categories.performance?.score);
    const accessibilityScore = getScore(categories.accessibility?.score);
    const bestPracticesScore = getScore(categories['best-practices']?.score);
    const seoScore = getScore(categories.seo?.score);

    console.log('📊 Extracted scores:', {
      performance: performanceScore,
      accessibility: accessibilityScore,
      bestPractices: bestPracticesScore,
      seo: seoScore
    });

    // Extract Core Web Vitals
    const firstContentfulPaint = audits['first-contentful-paint']?.numericValue || null;
    const largestContentfulPaint = audits['largest-contentful-paint']?.numericValue || null;
    const totalBlockingTime = audits['total-blocking-time']?.numericValue || null;
    const cumulativeLayoutShift = audits['cumulative-layout-shift']?.numericValue || null;
    const speedIndex = audits['speed-index']?.numericValue || null;
    const timeToInteractive = audits['interactive']?.numericValue || null;

    // Prepare data for database
    const resultData = {
      domain_id: domainId,
      url: normalizedUrl, // Use normalized URL
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

    // Save to database (upsert to handle duplicates)
    const { data: savedResult, error: saveError } = await supabase
      .from("pagespeed_results")
      .upsert(resultData, {
        onConflict: 'domain_id,url,strategy',
        ignoreDuplicates: false,
      })
      .select()
      .single();

    if (saveError) {
      console.error("Error saving PageSpeed result:", saveError);
      // Still return the data even if save fails
    }

    return NextResponse.json({
      success: true,
      fromCache: false,
      data: savedResult || resultData,
    });

  } catch (error: any) {
    console.error("PageSpeed API route error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

