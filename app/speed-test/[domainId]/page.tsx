"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import LoadingSpinner from "@/components/LoadingSpinner";
import { Gauge, Globe, ArrowLeft, RefreshCw, Smartphone, Monitor, AlertCircle, CheckCircle } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

interface PageSpeedResult {
  id: string;
  domain_id: string;
  url: string;
  strategy: 'mobile' | 'desktop';
  performance_score: number;
  accessibility_score: number;
  best_practices_score: number;
  seo_score: number;
  first_contentful_paint: number | null;
  largest_contentful_paint: number | null;
  total_blocking_time: number | null;
  cumulative_layout_shift: number | null;
  speed_index: number | null;
  time_to_interactive: number | null;
  tested_at: string;
}

interface Domain {
  id: string;
  domain_name: string;
  display_name: string | null;
  uptime_url: string;
  inner_pages: string[] | null;
}

export default function SpeedTestAnalysisPage() {
  const params = useParams();
  const router = useRouter();
  const domainId = params.domainId as string;
  
  const [domain, setDomain] = useState<Domain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [strategy, setStrategy] = useState<'mobile' | 'desktop'>('mobile');
  const [testingUrl, setTestingUrl] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, PageSpeedResult>>({});
  const [fromCache, setFromCache] = useState<Record<string, boolean>>({});

  const supabase = createClient();

  // Helper function to normalize URLs (must be defined before use)
  const normalizeUrl = (url: string): string => {
    let normalized = url.trim();
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = `https://${normalized}`;
    }
    return normalized;
  };

  useEffect(() => {
    fetchDomain();
  }, [domainId]);

  useEffect(() => {
    if (domain) {
      fetchAllResults();
    }
  }, [domain, strategy]);

  // Periodic refresh to check for completed tests
  useEffect(() => {
    if (!domain) return;

    const interval = setInterval(() => {
      // Check for any URLs that are still testing
      const urlsToTest = [domain.uptime_url, ...(domain.inner_pages || [])];
      
      urlsToTest.forEach(async (url) => {
        const normalizedUrl = normalizeUrl(url);
        
        // Only check if this URL is currently testing
        if (testingUrl === url || testingUrl === normalizedUrl || 
            (results[url] && results[url].performance_score === null)) {
          
          const { data: result } = await supabase
            .from("pagespeed_results")
            .select("*")
            .eq("domain_id", domainId)
            .in("url", [url, normalizedUrl])
            .eq("strategy", strategy)
            .order("tested_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (result && result.performance_score !== null && result.performance_score >= 0) {
            // Test completed!
            const resultUrl = result.url;
            setResults((prev) => ({
              ...prev,
              [url]: result,
              [resultUrl]: result,
              [normalizedUrl]: result,
            }));
            setFromCache((prev) => ({
              ...prev,
              [url]: false,
            }));
            setTestingUrl((prev) => {
              if (prev === url || prev === normalizedUrl || prev === resultUrl) {
                return null;
              }
              return prev;
            });
            console.log(`✅ Periodic check: Test completed for ${url}`);
          }
        }
      });
    }, 3000); // Check every 3 seconds

    return () => clearInterval(interval);
  }, [domain, domainId, strategy, testingUrl, results]);

  const fetchDomain = async () => {
    try {
      const { data, error: domainError } = await supabase
        .from("domains")
        .select("*")
        .eq("id", domainId)
        .single();

      if (domainError) throw domainError;
      if (!data) throw new Error("Domain not found");

      // Parse inner_pages
      let innerPages: string[] = [];
      if (data.inner_pages) {
        try {
          innerPages = typeof data.inner_pages === 'string' 
            ? JSON.parse(data.inner_pages) 
            : data.inner_pages;
          if (!Array.isArray(innerPages)) {
            innerPages = [];
          }
        } catch (e) {
          innerPages = [];
        }
      }

      setDomain({
        ...data,
        inner_pages: innerPages,
      });
    } catch (err: any) {
      console.error("Error fetching domain:", err);
      setError(err.message || "Failed to fetch domain");
    } finally {
      setLoading(false);
    }
  };

  const fetchAllResults = async () => {
    if (!domain) return;

    const urlsToTest = [domain.uptime_url, ...(domain.inner_pages || [])];
    
    console.log(`🔍 Checking database for ${urlsToTest.length} URLs...`);
    
    // FIRST: Check database for all URLs in parallel
    const cacheChecks = urlsToTest.map(async (url) => {
      const normalizedUrl = normalizeUrl(url);
      
      // Check both original and normalized URL
      const { data: existingResult, error: dbError } = await supabase
        .from("pagespeed_results")
        .select("*")
        .eq("domain_id", domainId)
        .in("url", [url, normalizedUrl]) // Check both versions
        .eq("strategy", strategy)
        .order("tested_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (dbError) {
        console.error(`Database error checking ${url}:`, dbError);
      }

      if (existingResult) {
        console.log(`📊 Found result for ${url}:`, {
          performance_score: existingResult.performance_score,
          tested_at: existingResult.tested_at
        });
        
        setResults((prev) => ({
          ...prev,
          [url]: existingResult,
          [normalizedUrl]: existingResult, // Also store with normalized key
        }));
        
        // Check if test is in progress (performance_score is null)
        if (existingResult.performance_score === null) {
          console.log(`⏳ Test in progress for ${url}`);
          setTestingUrl(url);
          // Start polling for this URL
          pollForResult(url);
          return { url, cached: true, hasData: false, inProgress: true };
        } else if (existingResult.performance_score >= 0) {
          console.log(`✅ Valid result found for ${url}, score: ${existingResult.performance_score}`);
          setFromCache((prev) => ({
            ...prev,
            [url]: true,
          }));
          return { url, cached: true, hasData: true, inProgress: false };
        } else {
          // Error state (performance_score === -1)
          return { url, cached: true, hasData: false, inProgress: false };
        }
      }
      
      console.log(`❌ No result found in database for ${url}`);
      return { url, cached: false, hasData: false, inProgress: false };
    });

    const cacheResults = await Promise.all(cacheChecks);
    
    // SECOND: Start background tests ONLY for URLs without data
    const urlsToTestInBackground = cacheResults
      .filter(result => !result.hasData && !result.inProgress)
      .map(result => result.url);

    console.log(`🚀 Starting ${urlsToTestInBackground.length} background tests...`);

    // Start all background tests automatically (fire and forget)
    urlsToTestInBackground.forEach(url => {
      setTestingUrl(url); // Set testing state immediately
      startBackgroundTest(url);
    });
  };

  const startBackgroundTest = async (url: string) => {
    if (!domain) return;

    // Mark as testing
    setTestingUrl(url);
    
    try {
      // Start background test (returns immediately)
      await fetch('/api/pagespeed/background', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          domainId,
          url,
          strategy,
        }),
      });

      // Start polling for results
      pollForResult(url);
    } catch (err: any) {
      console.error("Error starting background test:", err);
      setTestingUrl(null);
    }
  };

  const pollForResult = async (url: string, maxAttempts = 60) => {
    let attempts = 0;
    const normalizedUrl = normalizeUrl(url);
    
    const poll = async () => {
      if (attempts >= maxAttempts) {
        console.warn(`Polling timeout for ${url} after ${maxAttempts} attempts`);
        setTestingUrl(null);
        return;
      }

      attempts++;

      try {
        // Try both original and normalized URL to handle any mismatch
        const { data: result } = await supabase
          .from("pagespeed_results")
          .select("*")
          .eq("domain_id", domainId)
          .in("url", [url, normalizedUrl]) // Check both versions
          .eq("strategy", strategy)
          .order("tested_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (result) {
          // Check if test completed (has valid score)
          if (result.performance_score !== null && result.performance_score >= 0) {
            // Test completed - store with both original and normalized URL keys
            const resultUrl = result.url;
            setResults((prev) => ({
              ...prev,
              [url]: result, // Keep original URL as key for UI
              [resultUrl]: result, // Also store with database URL
              [normalizedUrl]: result, // Store with normalized version
            }));
            setFromCache((prev) => ({
              ...prev,
              [url]: false,
              [resultUrl]: false,
              [normalizedUrl]: false,
            }));
            setTestingUrl((prev) => {
              if (prev === url || prev === normalizedUrl || prev === resultUrl) {
                return null;
              }
              return prev;
            });
            console.log(`✅ Test completed for ${url} (stored as ${resultUrl}), score: ${result.performance_score}`);
            return;
          }
          
          // Test is still in progress (performance_score is null)
          // Update result in state to show it's queued
          setResults((prev) => ({
            ...prev,
            [url]: result,
            [normalizedUrl]: result,
          }));
        } else if (attempts === 1) {
          // First attempt - log that we're starting to poll
          console.log(`🔍 Starting to poll for ${url} (checking as ${normalizedUrl})`);
        }

        // Continue polling
        setTimeout(poll, 2000); // Poll every 2 seconds
      } catch (err) {
        console.error("Error polling for result:", err);
        setTimeout(poll, 2000);
      }
    };

    poll();
  };

  const fetchPageSpeedResult = async (url: string, forceRefresh = false) => {
    if (!domain) return;

    // Start background test instead of waiting
    await startBackgroundTest(url);
  };

  const getScoreColor = (score: number) => {
    if (score >= 90) return "text-green-600 dark:text-green-400";
    if (score >= 50) return "text-yellow-600 dark:text-yellow-400";
    return "text-red-600 dark:text-red-400";
  };

  const getScoreBgColor = (score: number) => {
    if (score >= 90) return "bg-green-100 dark:bg-green-900/20";
    if (score >= 50) return "bg-yellow-100 dark:bg-yellow-900/20";
    return "bg-red-100 dark:bg-red-900/20";
  };

  const formatMetric = (value: number | null, unit: string = 'ms') => {
    if (value === null) return 'N/A';
    if (value >= 1000) {
      return `${(value / 1000).toFixed(2)}s`;
    }
    return `${Math.round(value)}${unit}`;
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-center items-center min-h-[400px]">
          <LoadingSpinner size="lg" />
        </div>
      </div>
    );
  }

  if (error && !domain) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Card className="border-red-300 bg-red-50 dark:bg-red-900/10">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3 text-red-700 dark:text-red-400">
              <AlertCircle className="h-5 w-5" />
              <p>{error}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!domain) return null;

  const urlsToShow = [domain.uptime_url, ...(domain.inner_pages || [])];

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <Button
          variant="ghost"
          onClick={() => router.push('/speed-test')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Speed Test
        </Button>
        <div className="flex items-center gap-3 mb-2">
          <Gauge className="h-8 w-8 text-brand" />
          <h1 className="text-4xl font-bold">PageSpeed Analysis</h1>
        </div>
        <p className="text-muted-foreground text-lg">
          {domain.display_name || domain.domain_name}
        </p>
      </div>

      {/* Strategy Selector */}
      <div className="mb-6">
        <Select value={strategy} onValueChange={(value) => setStrategy(value as 'mobile' | 'desktop')}>
          <SelectTrigger className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mobile">
              <div className="flex items-center gap-2">
                <Smartphone className="h-4 w-4" />
                Mobile
              </div>
            </SelectItem>
            <SelectItem value="desktop">
              <div className="flex items-center gap-2">
                <Monitor className="h-4 w-4" />
                Desktop
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && (
        <Card className="mb-6 border-red-300 bg-red-50 dark:bg-red-900/10">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3 text-red-700 dark:text-red-400">
              <AlertCircle className="h-5 w-5" />
              <p>{error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6">
        {urlsToShow.map((url) => {
          // Normalize URL to check both versions
          const normalizedUrl = normalizeUrl(url);
          const result = results[url] || results[normalizedUrl];
          
          // Check if testing: explicitly set, or result exists with null performance_score
          const isTesting = testingUrl === url || testingUrl === normalizedUrl || (result && result.performance_score === null);
          const cached = fromCache[url] || fromCache[normalizedUrl];

          return (
            <Card key={url} className="hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <CardTitle className="text-lg mb-2 flex items-center gap-2">
                      <Globe className="h-5 w-5" />
                      <span className="font-mono text-sm break-all">{url}</span>
                    </CardTitle>
                    {cached && (
                      <CardDescription className="text-xs">
                        Results from cache (tested within last 24 hours)
                      </CardDescription>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchPageSpeedResult(url, true)}
                    disabled={isTesting}
                  >
                    {isTesting ? (
                      <>
                        <div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
                        Testing...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Refresh
                      </>
                    )}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {(isTesting || (result && result.performance_score === null)) ? (
                  <div className="flex flex-col justify-center items-center py-8">
                    <LoadingSpinner size="lg" />
                    <p className="text-sm text-muted-foreground mt-4">
                      Running PageSpeed test in background...
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      This may take 30-60 seconds. Results will appear automatically.
                    </p>
                    {result && result.performance_score === null && (
                      <p className="text-xs text-blue-600 dark:text-blue-400 mt-2">
                        Test queued and running...
                      </p>
                    )}
                  </div>
                ) : result && result.performance_score === -1 ? (
                  <div className="text-center py-8">
                    <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
                    <p className="text-sm text-red-600 dark:text-red-400">
                      Test failed. Please try again.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-4"
                      onClick={() => fetchPageSpeedResult(url, true)}
                    >
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Retry Test
                    </Button>
                  </div>
                ) : result && result.performance_score !== null && result.performance_score >= 0 ? (
                  <div className="space-y-6">
                    {/* Scores */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className={`p-4 rounded-lg ${getScoreBgColor(result.performance_score)}`}>
                        <div className="text-xs text-muted-foreground mb-1">Performance</div>
                        <div className={`text-3xl font-bold ${getScoreColor(result.performance_score)}`}>
                          {result.performance_score}
                        </div>
                      </div>
                      <div className={`p-4 rounded-lg ${getScoreBgColor(result.accessibility_score)}`}>
                        <div className="text-xs text-muted-foreground mb-1">Accessibility</div>
                        <div className={`text-3xl font-bold ${getScoreColor(result.accessibility_score)}`}>
                          {result.accessibility_score}
                        </div>
                      </div>
                      <div className={`p-4 rounded-lg ${getScoreBgColor(result.best_practices_score)}`}>
                        <div className="text-xs text-muted-foreground mb-1">Best Practices</div>
                        <div className={`text-3xl font-bold ${getScoreColor(result.best_practices_score)}`}>
                          {result.best_practices_score}
                        </div>
                      </div>
                      <div className={`p-4 rounded-lg ${getScoreBgColor(result.seo_score)}`}>
                        <div className="text-xs text-muted-foreground mb-1">SEO</div>
                        <div className={`text-3xl font-bold ${getScoreColor(result.seo_score)}`}>
                          {result.seo_score}
                        </div>
                      </div>
                    </div>

                    {/* Core Web Vitals */}
                    <div>
                      <h3 className="text-sm font-semibold mb-3">Core Web Vitals</h3>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="p-3 border rounded-lg">
                          <div className="text-xs text-muted-foreground mb-1">LCP</div>
                          <div className="text-lg font-semibold">
                            {formatMetric(result.largest_contentful_paint)}
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            Largest Contentful Paint
                          </div>
                        </div>
                        <div className="p-3 border rounded-lg">
                          <div className="text-xs text-muted-foreground mb-1">FID / TBT</div>
                          <div className="text-lg font-semibold">
                            {formatMetric(result.total_blocking_time)}
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            Total Blocking Time
                          </div>
                        </div>
                        <div className="p-3 border rounded-lg">
                          <div className="text-xs text-muted-foreground mb-1">CLS</div>
                          <div className="text-lg font-semibold">
                            {result.cumulative_layout_shift !== null 
                              ? result.cumulative_layout_shift.toFixed(3)
                              : 'N/A'}
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            Cumulative Layout Shift
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Additional Metrics */}
                    <div>
                      <h3 className="text-sm font-semibold mb-3">Additional Metrics</h3>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="p-3 border rounded-lg">
                          <div className="text-xs text-muted-foreground mb-1">FCP</div>
                          <div className="text-lg font-semibold">
                            {formatMetric(result.first_contentful_paint)}
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            First Contentful Paint
                          </div>
                        </div>
                        <div className="p-3 border rounded-lg">
                          <div className="text-xs text-muted-foreground mb-1">Speed Index</div>
                          <div className="text-lg font-semibold">
                            {formatMetric(result.speed_index)}
                          </div>
                        </div>
                        <div className="p-3 border rounded-lg">
                          <div className="text-xs text-muted-foreground mb-1">TTI</div>
                          <div className="text-lg font-semibold">
                            {formatMetric(result.time_to_interactive)}
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            Time to Interactive
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="text-xs text-muted-foreground pt-2 border-t">
                      Last tested: {new Date(result.tested_at).toLocaleString()}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <LoadingSpinner size="md" />
                    <p className="text-muted-foreground mt-4">Starting test automatically...</p>
                    <p className="text-xs text-muted-foreground mt-2">
                      Test will begin shortly. Results will appear automatically.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

