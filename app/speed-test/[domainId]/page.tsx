"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import LoadingSpinner from "@/components/LoadingSpinner";
import { Gauge, Globe, ArrowLeft, RefreshCw, Smartphone, Monitor, AlertCircle, CheckCircle, Copy, Check } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

interface PageSpeedResult {
  id: string;
  domain_id: string;
  url: string;
  strategy: 'mobile' | 'desktop';
  performance_score: number | null;
  accessibility_score: number | null;
  best_practices_score: number | null;
  seo_score: number | null;
  first_contentful_paint: number | null;
  largest_contentful_paint: number | null;
  total_blocking_time: number | null;
  cumulative_layout_shift: number | null;
  speed_index: number | null;
  time_to_interactive: number | null;
  raw_data: any; // Full PageSpeed Insights API response
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
  // Store results with composite key: `${url}-${strategy}`
  const [results, setResults] = useState<Record<string, PageSpeedResult>>({});
  const [fromCache, setFromCache] = useState<Record<string, boolean>>({});
  const [testingUrls, setTestingUrls] = useState<Set<string>>(new Set());
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

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
      // When strategy changes, immediately check database for current strategy
      // This should run first and load existing data
      checkDatabaseForCurrentStrategy().then(() => {
        // Only after checking current strategy, fetch all results (which will start tests if needed)
        // But don't start tests for strategies that already have data
        fetchAllResults();
      });
    }
  }, [domain, strategy]);

  // Separate function to check database for current strategy and load results immediately
  const checkDatabaseForCurrentStrategy = async () => {
    if (!domain) return;

    const urlsToCheck = [domain.uptime_url, ...(domain.inner_pages || [])];
    
    console.log(`🔍 [${strategy.toUpperCase()}] Checking database for current strategy (${strategy})...`);
    
    // Check database for current strategy only
    const checks = urlsToCheck.map(async (url) => {
      const normalizedUrl = normalizeUrl(url);
      const resultKey = `${url}-${strategy}`;
      
      console.log(`🔍 [${strategy.toUpperCase()}] Querying database for: ${url} (normalized: ${normalizedUrl})`);
      
      const { data: existingResult, error: dbError } = await supabase
        .from("pagespeed_results")
        .select("*")
        .eq("domain_id", domainId)
        .in("url", [url, normalizedUrl])
        .eq("strategy", strategy)
        .order("tested_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (dbError) {
        console.error(`❌ [${strategy.toUpperCase()}] Database error checking ${url}:`, dbError);
        return;
      }

      if (existingResult) {
        console.log(`✅ [${strategy.toUpperCase()}] Found result in database for ${url}:`, {
          id: existingResult.id,
          performance_score: existingResult.performance_score,
          strategy: existingResult.strategy,
          url: existingResult.url,
          tested_at: existingResult.tested_at
        });
        
        if (existingResult.performance_score !== null && existingResult.performance_score >= 0) {
          // Valid result - mark as cached
          console.log(`✅ [${strategy.toUpperCase()}] Valid result found, loading into state for ${resultKey}`);
          
          // Immediately load into state
          setResults((prev) => {
            const updated = {
              ...prev,
              [resultKey]: existingResult,
            };
            console.log(`💾 [${strategy.toUpperCase()}] Updated results state for key: ${resultKey}`, {
              hasResult: !!updated[resultKey],
              performance_score: updated[resultKey]?.performance_score
            });
            return updated;
          });
          
          setFromCache((prev) => ({
            ...prev,
            [resultKey]: true,
          }));
          // Make sure it's not marked as testing
          setTestingUrls((prev) => {
            const next = new Set(prev);
            const wasTesting = next.has(resultKey);
            next.delete(resultKey);
            if (wasTesting) {
              console.log(`🔄 [${strategy.toUpperCase()}] Removed ${resultKey} from testing set`);
            }
            return next;
          });
        } else if (existingResult.performance_score === null) {
          // Test queued/in progress - check if it's stale (older than 10 minutes)
          const testedAt = new Date(existingResult.tested_at);
          const now = new Date();
          const minutesAgo = (now.getTime() - testedAt.getTime()) / (1000 * 60);
          
          if (minutesAgo > 10) {
            // Stale queued record - treat as if no data exists
            console.log(`⚠️ [${strategy.toUpperCase()}] Stale queued record for ${url} (${Math.round(minutesAgo)} minutes old), treating as no data`);
            setTestingUrls((prev) => {
              const next = new Set(prev);
              next.delete(resultKey);
              return next;
            });
            // Don't load stale result into state - return as if no data
            return;
          } else {
            // Recent queued record - test might still be running
            console.log(`⏳ [${strategy.toUpperCase()}] Test in progress for ${url} (${Math.round(minutesAgo)} minutes ago)`);
            
            // Load into state to show "queued" status
            setResults((prev) => ({
              ...prev,
              [resultKey]: existingResult,
            }));
            
            setTestingUrls((prev) => new Set(prev).add(resultKey));
            pollForResult(url, strategy);
            // Return as in progress so we don't start a new test
            return;
          }
        } else {
          // Error state (performance_score === -1)
          console.log(`❌ [${strategy.toUpperCase()}] Error state for ${url}`);
          setTestingUrls((prev) => {
            const next = new Set(prev);
            next.delete(resultKey);
            return next;
          });
          // Load error state into results
          setResults((prev) => ({
            ...prev,
            [resultKey]: existingResult,
          }));
        }
      } else {
        // No result found
        console.log(`❌ [${strategy.toUpperCase()}] No result in database for ${url} (${strategy})`);
        // Make sure it's not marked as testing if no data exists
        setTestingUrls((prev) => {
          const next = new Set(prev);
          next.delete(resultKey);
          return next;
        });
      }
    });

    await Promise.all(checks);
    console.log(`✅ [${strategy.toUpperCase()}] Finished checking database for current strategy`);
  };

  // Periodic refresh to check for completed tests
  useEffect(() => {
    if (!domain) return;

    const interval = setInterval(() => {
      // Check for any URLs that are still testing
      const urlsToTest = [domain.uptime_url, ...(domain.inner_pages || [])];
      const strategies: ('mobile' | 'desktop')[] = ['mobile', 'desktop'];
      
      urlsToTest.forEach(async (url) => {
        const normalizedUrl = normalizeUrl(url);
        
        strategies.forEach(async (strat) => {
          const resultKey = `${url}-${strat}`;
          
          // Only check if this URL+strategy is currently testing
          if (testingUrls.has(resultKey) || 
              (results[resultKey] && results[resultKey].performance_score === null)) {
            
            const { data: result } = await supabase
              .from("pagespeed_results")
              .select("*")
              .eq("domain_id", domainId)
              .in("url", [url, normalizedUrl])
              .eq("strategy", strat)
              .order("tested_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            if (result && result.performance_score !== null && result.performance_score >= 0) {
              // Test completed!
              setResults((prev) => ({
                ...prev,
                [resultKey]: result,
              }));
              setFromCache((prev) => ({
                ...prev,
                [resultKey]: false,
              }));
              setTestingUrls((prev) => {
                const next = new Set(prev);
                next.delete(resultKey);
                return next;
              });
              console.log(`✅ Periodic check: Test completed for ${url} (${strat})`);
            }
          }
        });
      });
    }, 3000); // Check every 3 seconds

    return () => clearInterval(interval);
  }, [domain, domainId, testingUrls, results]);

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
    const strategies: ('mobile' | 'desktop')[] = ['mobile', 'desktop'];
    
    console.log(`🔍 Checking database for ${urlsToTest.length} URLs (both mobile and desktop)...`);
    
    // FIRST: Check database for all URLs and both strategies in parallel
    const cacheChecks = urlsToTest.flatMap(url => 
      strategies.map(async (strat) => {
        const normalizedUrl = normalizeUrl(url);
        const resultKey = `${url}-${strat}`;
        
        // Check both original and normalized URL
        const { data: existingResult, error: dbError } = await supabase
          .from("pagespeed_results")
          .select("*")
          .eq("domain_id", domainId)
          .in("url", [url, normalizedUrl]) // Check both versions
          .eq("strategy", strat)
          .order("tested_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (dbError) {
          console.error(`Database error checking ${url} (${strat}):`, dbError);
        }

        if (existingResult) {
          console.log(`📊 Found result for ${url} (${strat}):`, {
            performance_score: existingResult.performance_score,
            tested_at: existingResult.tested_at
          });
          
          // Check if test is in progress (performance_score is null)
          if (existingResult.performance_score === null) {
            // Check if it's stale (older than 10 minutes)
            const testedAt = new Date(existingResult.tested_at);
            const now = new Date();
            const minutesAgo = (now.getTime() - testedAt.getTime()) / (1000 * 60);
            
            if (minutesAgo > 10) {
              // Stale queued record - treat as if no data exists
              console.log(`⚠️ Stale queued record for ${url} (${strat}) (${Math.round(minutesAgo)} minutes old), will start new test`);
              setTestingUrls((prev) => {
                const next = new Set(prev);
                next.delete(resultKey);
                return next;
              });
              return { url, strategy: strat, cached: false, hasData: false, inProgress: false };
            } else {
              // Recent queued record - test might still be running
              console.log(`⏳ Test in progress for ${url} (${strat}) (${Math.round(minutesAgo)} minutes ago)`);
              
              // Load into state to show "queued" status
              setResults((prev) => ({
                ...prev,
                [resultKey]: existingResult,
              }));
              
              setTestingUrls((prev) => new Set(prev).add(resultKey));
              // Start polling for this URL+strategy
              pollForResult(url, strat);
              return { url, strategy: strat, cached: true, hasData: false, inProgress: true };
            }
          } else if (existingResult.performance_score >= 0) {
            console.log(`✅ Valid result found for ${url} (${strat}), score: ${existingResult.performance_score}`);
            
            // Always update state with existing result
            setResults((prev) => ({
              ...prev,
              [resultKey]: existingResult,
            }));
            
            setFromCache((prev) => ({
              ...prev,
              [resultKey]: true,
            }));
            // Make sure it's not marked as testing
            setTestingUrls((prev) => {
              const next = new Set(prev);
              next.delete(resultKey);
              return next;
            });
            return { url, strategy: strat, cached: true, hasData: true, inProgress: false };
          } else {
            // Error state (performance_score === -1)
            setTestingUrls((prev) => {
              const next = new Set(prev);
              next.delete(resultKey);
              return next;
            });
            // Load error state into results
            setResults((prev) => ({
              ...prev,
              [resultKey]: existingResult,
            }));
            return { url, strategy: strat, cached: true, hasData: false, inProgress: false };
          }
        }
        
        console.log(`❌ No result found in database for ${url} (${strat})`);
        // Make sure it's not marked as testing if no data exists
        setTestingUrls((prev) => {
          const next = new Set(prev);
          next.delete(resultKey);
          return next;
        });
        return { url, strategy: strat, cached: false, hasData: false, inProgress: false };
      })
    );

    const cacheResults = await Promise.all(cacheChecks);
    
    // SECOND: Start background tests ONLY for URLs+strategies without data AND not in progress
    const testsToStart = cacheResults
      .filter(result => !result.hasData && !result.inProgress)
      .map(result => ({ url: result.url, strategy: result.strategy }));

    console.log(`🚀 Starting ${testsToStart.length} background tests (both mobile and desktop in parallel)...`);

    // Start all background tests automatically (fire and forget) - both strategies in parallel
    testsToStart.forEach(({ url, strategy: strat }) => {
      const resultKey = `${url}-${strat}`;
      setTestingUrls((prev) => new Set(prev).add(resultKey));
      startBackgroundTest(url, strat);
    });
  };

  const startBackgroundTest = async (url: string, strat: 'mobile' | 'desktop' = strategy) => {
    if (!domain) return;

    const resultKey = `${url}-${strat}`;
    
    // Mark as testing
    setTestingUrls((prev) => new Set(prev).add(resultKey));
    
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
          strategy: strat,
        }),
      });

      // Start polling for results
      pollForResult(url, strat);
    } catch (err: any) {
      console.error(`Error starting background test for ${url} (${strat}):`, err);
      setTestingUrls((prev) => {
        const next = new Set(prev);
        next.delete(resultKey);
        return next;
      });
    }
  };

  const pollForResult = async (url: string, strat: 'mobile' | 'desktop', maxAttempts = 60) => {
    let attempts = 0;
    const normalizedUrl = normalizeUrl(url);
    const resultKey = `${url}-${strat}`;
    
    const poll = async () => {
      if (attempts >= maxAttempts) {
        console.warn(`Polling timeout for ${url} (${strat}) after ${maxAttempts} attempts`);
        setTestingUrls((prev) => {
          const next = new Set(prev);
          next.delete(resultKey);
          return next;
        });
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
          .eq("strategy", strat)
          .order("tested_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (result) {
          // Check if test completed (has valid score)
          if (result.performance_score !== null && result.performance_score >= 0) {
            // Test completed - store with composite key
            setResults((prev) => ({
              ...prev,
              [resultKey]: result,
            }));
            setFromCache((prev) => ({
              ...prev,
              [resultKey]: false,
            }));
            setTestingUrls((prev) => {
              const next = new Set(prev);
              next.delete(resultKey);
              return next;
            });
            console.log(`✅ Test completed for ${url} (${strat}), score: ${result.performance_score}`);
            return;
          }
          
          // Test is still in progress (performance_score is null)
          // Update result in state to show it's queued
          setResults((prev) => ({
            ...prev,
            [resultKey]: result,
          }));
        } else if (attempts === 1) {
          // First attempt - log that we're starting to poll
          console.log(`🔍 Starting to poll for ${url} (${strat}) (checking as ${normalizedUrl})`);
        }

        // Continue polling
        setTimeout(poll, 2000); // Poll every 2 seconds
      } catch (err) {
        console.error(`Error polling for result (${url}, ${strat}):`, err);
        setTimeout(poll, 2000);
      }
    };

    poll();
  };

  const fetchPageSpeedResult = async (url: string, forceRefresh = false) => {
    if (!domain) return;

    // Start background tests for both mobile and desktop in parallel
    await Promise.all([
      startBackgroundTest(url, 'mobile'),
      startBackgroundTest(url, 'desktop'),
    ]);
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

  const copyRawData = async (url: string) => {
    const resultKey = `${url}-${strategy}`;
    const result = results[resultKey];
    
    if (!result || !result.raw_data) {
      console.error('No raw data available for', url);
      return;
    }

    try {
      const jsonString = JSON.stringify(result.raw_data, null, 2);
      await navigator.clipboard.writeText(jsonString);
      setCopiedUrl(resultKey);
      setTimeout(() => setCopiedUrl(null), 2000);
    } catch (err) {
      console.error('Failed to copy raw data:', err);
    }
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
          // Use composite key for results: `${url}-${strategy}`
          const resultKey = `${url}-${strategy}`;
          const result = results[resultKey];
          
          // Debug logging
          if (strategy === 'desktop') {
            console.log(`🖥️ [UI] Desktop check for ${url}:`, {
              resultKey,
              hasResult: !!result,
              performance_score: result?.performance_score,
              inTestingSet: testingUrls.has(resultKey),
              cached: fromCache[resultKey]
            });
          }
          
          // Check if testing: only if explicitly in testingUrls set AND result has null score
          // If result exists with valid score, it's not testing
          const hasValidResult = result && result.performance_score !== null && result.performance_score >= 0;
          const isTesting = !hasValidResult && (testingUrls.has(resultKey) || (result && result.performance_score === null));
          const cached = fromCache[resultKey];

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
                  <div className="flex items-center gap-2">
                    {result && result.raw_data && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyRawData(url)}
                        title="Copy raw PageSpeed data to clipboard"
                      >
                        {copiedUrl === `${url}-${strategy}` ? (
                          <>
                            <Check className="h-4 w-4 mr-2" />
                            Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="h-4 w-4 mr-2" />
                            Copy Data
                          </>
                        )}
                      </Button>
                    )}
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
                </div>
              </CardHeader>
              <CardContent>
                {/* Show valid result if it exists */}
                {result && result.performance_score !== null && result.performance_score >= 0 ? (
                  <div className="space-y-6">
                    {/* Scores */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className={`p-4 rounded-lg ${result.performance_score !== null ? getScoreBgColor(result.performance_score) : 'bg-gray-100 dark:bg-gray-800'}`}>
                        <div className="text-xs text-muted-foreground mb-1">Performance</div>
                        <div className={`text-3xl font-bold ${result.performance_score !== null ? getScoreColor(result.performance_score) : 'text-gray-500'}`}>
                          {result.performance_score !== null ? result.performance_score : 'N/A'}
                        </div>
                      </div>
                      <div className={`p-4 rounded-lg ${result.accessibility_score !== null ? getScoreBgColor(result.accessibility_score) : 'bg-gray-100 dark:bg-gray-800'}`}>
                        <div className="text-xs text-muted-foreground mb-1">Accessibility</div>
                        <div className={`text-3xl font-bold ${result.accessibility_score !== null ? getScoreColor(result.accessibility_score) : 'text-gray-500'}`}>
                          {result.accessibility_score !== null ? result.accessibility_score : 'N/A'}
                        </div>
                      </div>
                      <div className={`p-4 rounded-lg ${result.best_practices_score !== null ? getScoreBgColor(result.best_practices_score) : 'bg-gray-100 dark:bg-gray-800'}`}>
                        <div className="text-xs text-muted-foreground mb-1">Best Practices</div>
                        <div className={`text-3xl font-bold ${result.best_practices_score !== null ? getScoreColor(result.best_practices_score) : 'text-gray-500'}`}>
                          {result.best_practices_score !== null ? result.best_practices_score : 'N/A'}
                        </div>
                      </div>
                      <div className={`p-4 rounded-lg ${result.seo_score !== null ? getScoreBgColor(result.seo_score) : 'bg-gray-100 dark:bg-gray-800'}`}>
                        <div className="text-xs text-muted-foreground mb-1">SEO</div>
                        <div className={`text-3xl font-bold ${result.seo_score !== null ? getScoreColor(result.seo_score) : 'text-gray-500'}`}>
                          {result.seo_score !== null ? result.seo_score : 'N/A'}
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
                          <div className="text-xs text-muted-foreground mt-2 pt-2 border-t">
                            Marks the time at which the largest text or image is painted.
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
                          <div className="text-xs text-muted-foreground mt-2 pt-2 border-t">
                            Sum of all time periods between FCP and Time to Interactive, when task length exceeded 50ms.
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
                          <div className="text-xs text-muted-foreground mt-2 pt-2 border-t">
                            Measures the movement of visible elements within the viewport.
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
                          <div className="text-xs text-muted-foreground mt-2 pt-2 border-t">
                            Marks the time at which the first text or image is painted.
                          </div>
                        </div>
                        <div className="p-3 border rounded-lg">
                          <div className="text-xs text-muted-foreground mb-1">Speed Index</div>
                          <div className="text-lg font-semibold">
                            {formatMetric(result.speed_index)}
                          </div>
                          <div className="text-xs text-muted-foreground mt-2 pt-2 border-t">
                            Shows how quickly the contents of a page are visibly populated.
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
                          <div className="text-xs text-muted-foreground mt-2 pt-2 border-t">
                            The amount of time it takes for the page to become fully interactive.
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="text-xs text-muted-foreground pt-2 border-t">
                      Last tested: {new Date(result.tested_at).toLocaleString()}
                    </div>
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
                ) : isTesting || (result && result.performance_score === null) ? (
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

