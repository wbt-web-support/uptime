"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import LoadingSpinner from "@/components/LoadingSpinner";
import { Gauge, Globe, ExternalLink, AlertCircle, Search, Plus, X, Trash2, Link as LinkIcon, RefreshCw, CheckCircle, Clock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

interface Domain {
  id: string;
  domain_name: string;
  display_name: string | null;
  uptime_url: string;
  created_at: string;
  notify_on_expiry: boolean | null;
  notify_on_downtime: boolean | null;
  category: string | null;
  tag: string | null;
  inner_pages: string[] | null;
}

export default function SpeedTestPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"domain" | "newest" | "oldest" | "category">("domain");
  const [openModal, setOpenModal] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState("");
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  const [addingUrls, setAddingUrls] = useState<Set<string>>(new Set());
  const [testingUrls, setTestingUrls] = useState<Set<string>>(new Set());
  const [speedTestResults, setSpeedTestResults] = useState<Record<string, {
    url: string;
    responseTime: number | null;
    status: 'success' | 'error' | 'testing';
    error?: string;
    timestamp: number;
  }>>({});

  const supabase = createClient();
  const router = useRouter();

  const fetchDomains = async () => {
    setLoading(true);
    setError("");
    try {
      const { data: domainsData, error: domainsError } = await supabase
        .from("domains")
        .select("*")
        .order("domain_name", { ascending: true });

      if (domainsError) throw domainsError;

      // Parse inner_pages if it's stored as JSON string
      const domainsWithParsedPages = (domainsData || []).map((domain: any) => {
        let innerPages: string[] = [];
        if (domain.inner_pages) {
          try {
            innerPages = typeof domain.inner_pages === 'string' 
              ? JSON.parse(domain.inner_pages) 
              : domain.inner_pages;
            // Ensure it's an array
            if (!Array.isArray(innerPages)) {
              innerPages = [];
            }
          } catch (e) {
            console.error("Error parsing inner_pages for domain", domain.id, e);
            innerPages = [];
          }
        }
        return {
          ...domain,
          inner_pages: innerPages
        };
      });

      setDomains(domainsWithParsedPages);
    } catch (err: any) {
      console.error("Error fetching domains:", err);
      setError(err.message || "Failed to fetch domains");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDomains();
  }, []);

  // Get all unique categories from domains
  const categories = ["all", ...Array.from(new Set(domains
    .filter(domain => domain.category)
    .map(domain => domain.category as string)
  ))];

  // Filter and sort domains
  const filteredDomains = domains
    .filter(domain => {
      const matchesSearch = 
        domain.domain_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (domain.display_name && domain.display_name.toLowerCase().includes(searchQuery.toLowerCase()));
      
      const matchesCategory = 
        categoryFilter === 'all' || 
        domain.category === categoryFilter;
      
      return matchesSearch && matchesCategory;
    })
    .sort((a, b) => {
      switch(sortBy) {
        case "newest":
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case "oldest":
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "category":
          return (a.category || "").localeCompare(b.category || "");
        case "domain":
        default:
          return (a.display_name || a.domain_name).localeCompare(b.display_name || b.domain_name);
      }
    });

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const parseUrls = (urlString: string): string[] => {
    // Split by newlines, commas, or spaces, then filter and trim
    return urlString
      .split(/[\n,]+/)
      .map((url) => url.trim())
      .filter((url) => url.length > 0);
  };

  const validateUrls = (urls: string[]): { valid: string[]; invalid: string[] } => {
    const valid: string[] = [];
    const invalid: string[] = [];

    urls.forEach((url) => {
      try {
        new URL(url);
        valid.push(url);
      } catch {
        invalid.push(url);
      }
    });

    return { valid, invalid };
  };

  const addSingleUrl = async (domainId: string, url: string) => {
    // Validate URL format
    try {
      new URL(url);
    } catch {
      setError(`Invalid URL: ${url}`);
      return;
    }

    // Get current domain
    const domain = domains.find((d) => d.id === domainId);
    if (!domain) return;

    // Check for duplicates
    const existingUrls = domain.inner_pages || [];
    if (existingUrls.includes(url)) {
      setError("This URL has already been added");
      return;
    }

    setAddingUrls((prev) => new Set(prev).add(url));
    setError("");

    try {
      // Update the domain with the new URL
      const updatedUrls = [...existingUrls, url];
      const { error: updateError } = await supabase
        .from("domains")
        .update({ inner_pages: updatedUrls })
        .eq("id", domainId);

      if (updateError) throw updateError;

      // Update local state
      setDomains((prev) =>
        prev.map((d) =>
          d.id === domainId ? { ...d, inner_pages: updatedUrls } : d
        )
      );
      
      // Clear input if this was the URL being added
      if (newUrl.trim() === url) {
        setNewUrl("");
      }
    } catch (err: any) {
      console.error("Error saving URL:", err);
      setError(err.message || "Failed to save URL");
    } finally {
      setAddingUrls((prev) => {
        const newSet = new Set(prev);
        newSet.delete(url);
        return newSet;
      });
    }
  };

  const removeUrl = async (domainId: string, urlIndex: number) => {
    const domain = domains.find((d) => d.id === domainId);
    if (!domain) return;

    const currentUrls = domain.inner_pages || [];
    const updatedUrls = currentUrls.filter((_, index) => index !== urlIndex);

    try {
      const { error: updateError } = await supabase
        .from("domains")
        .update({ inner_pages: updatedUrls })
        .eq("id", domainId);

      if (updateError) throw updateError;

      // Update local state
      setDomains((prev) =>
        prev.map((d) =>
          d.id === domainId ? { ...d, inner_pages: updatedUrls } : d
        )
      );
    } catch (err: any) {
      console.error("Error removing URL:", err);
      setError(err.message || "Failed to remove URL");
    }
  };

  const testUrlSpeed = async (url: string) => {
    setTestingUrls((prev) => new Set(prev).add(url));
    setSpeedTestResults((prev) => ({
      ...prev,
      [url]: {
        url,
        responseTime: null,
        status: 'testing',
        timestamp: Date.now(),
      },
    }));

    try {
      const startTime = performance.now();
      
      // Create an abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      try {
        const response = await fetch(url, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
          redirect: 'follow',
        });

        const endTime = performance.now();
        const responseTime = Math.round(endTime - startTime);
        clearTimeout(timeoutId);

        const status: 'success' | 'error' = response.ok ? 'success' : 'error';
        const error = response.ok ? undefined : `Status: ${response.status}`;

        setSpeedTestResults((prev) => ({
          ...prev,
          [url]: {
            url,
            responseTime,
            status,
            error,
            timestamp: Date.now(),
          },
        }));
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        const endTime = performance.now();
        const responseTime = Math.round(endTime - startTime);
        
        // If it's a timeout or network error, we still got a response time
        if (fetchError.name === 'AbortError') {
          setSpeedTestResults((prev) => ({
            ...prev,
            [url]: {
              url,
              responseTime,
              status: 'error',
              error: 'Timeout (10s)',
              timestamp: Date.now(),
            },
          }));
        } else {
          setSpeedTestResults((prev) => ({
            ...prev,
            [url]: {
              url,
              responseTime: responseTime < 10000 ? responseTime : null,
              status: 'error',
              error: fetchError.message || 'Failed to fetch',
              timestamp: Date.now(),
            },
          }));
        }
      }
    } catch (err: any) {
      setSpeedTestResults((prev) => ({
        ...prev,
        [url]: {
          url,
          responseTime: null,
          status: 'error',
          error: err.message || 'Failed to test URL',
          timestamp: Date.now(),
        },
      }));
    } finally {
      setTestingUrls((prev) => {
        const newSet = new Set(prev);
        newSet.delete(url);
        return newSet;
      });
    }
  };

  const testAllUrlsForDomain = async (domain: Domain) => {
    const urlsToTest = [domain.uptime_url, ...(domain.inner_pages || [])];
    
    // Test all URLs in parallel
    await Promise.allSettled(
      urlsToTest.map(url => testUrlSpeed(url))
    );
  };

  const startBackgroundTestsForDomain = async (domain: Domain) => {
    const urlsToTest = [domain.uptime_url, ...(domain.inner_pages || [])];
    
    // Start all background tests (fire and forget)
    urlsToTest.forEach(async (url) => {
      try {
        await fetch('/api/pagespeed/background', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            domainId: domain.id,
            url,
            strategy: 'mobile', // Default, user can change on analysis page
          }),
        });
      } catch (err) {
        console.error(`Error starting background test for ${url}:`, err);
      }
    });
  };

  const openAddUrlModal = (domainId: string) => {
    setOpenModal(domainId);
    setNewUrl("");
    setError("");
  };

  const closeModal = () => {
    setOpenModal(null);
    setNewUrl("");
    setError("");
    setAddingUrls(new Set());
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Gauge className="h-8 w-8 text-brand" />
          <h1 className="text-4xl font-bold">Speed Test</h1>
        </div>
        <p className="text-muted-foreground text-lg">
          Test the speed and performance of all monitored domains
        </p>
      </div>

      {/* Filters and Search */}
      <div className="mb-6 space-y-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
              type="text"
              placeholder="Search domains..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-full sm:w-[200px]">
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((category) => (
                <SelectItem key={category} value={category}>
                  {category === "all" ? "All Categories" : category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(value) => setSortBy(value as any)}>
            <SelectTrigger className="w-full sm:w-[200px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="domain">Sort by Domain</SelectItem>
              <SelectItem value="newest">Newest First</SelectItem>
              <SelectItem value="oldest">Oldest First</SelectItem>
              <SelectItem value="category">Sort by Category</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="text-sm text-muted-foreground">
          Showing {filteredDomains.length} of {domains.length} domains
        </div>
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

      {loading ? (
        <div className="py-20">
          <LoadingSpinner size="lg" />
        </div>
      ) : filteredDomains.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="text-center py-16">
              <Globe className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-xl font-medium mb-2">No domains found</h3>
              <p className="text-muted-foreground">
                {domains.length === 0
                  ? "There are no domains in the database."
                  : "No domains match your search criteria."}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredDomains.map((domain) => (
            <Card 
              key={domain.id} 
              className="hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => {
                // Start background tests for this domain before navigating
                startBackgroundTestsForDomain(domain);
                router.push(`/speed-test/${domain.id}`);
              }}
            >
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <CardTitle className="text-lg mb-1">
                      {domain.display_name || domain.domain_name}
                    </CardTitle>
                    <CardDescription className="flex items-center gap-1 mt-1">
                      <Globe className="h-3 w-3" />
                      <a
                      href={domain.uptime_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-brand hover:underline flex items-center gap-1"
                    > <span className="text-xs">{domain.domain_name}</span>
                   
                    </a>
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                   
                    
                      
                  </div>
                  
                  {domain.category && (
                    <div>
                      <span className="text-xs text-muted-foreground">Category: </span>
                      <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
                        {domain.category}
                      </span>
                    </div>
                  )}
                  
                  {domain.tag && (
                    <div>
                      <span className="text-xs text-muted-foreground">Tag: </span>
                      <span className="text-xs font-medium text-purple-600 dark:text-purple-400">
                        {domain.tag}
                      </span>
                    </div>
                  )}
                  
                  <div>
                    <span className="text-xs text-muted-foreground">Added: </span>
                    <span className="text-xs">{formatDate(domain.created_at)}</span>
                  </div>

                  {/* Speed Test Results */}
                  <div className="pt-2 border-t space-y-2">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        Speed Test Results:
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/speed-test/${domain.id}`);
                        }}
                      >
                        <Gauge className="h-3 w-3 mr-1" />
                        View Analysis
                      </Button>
                    </div>

                    {/* Main URL Test Result */}
                    <div className="space-y-1">
                      <div
                        className={`flex items-center gap-2 p-2 rounded-md text-xs border ${
                          speedTestResults[domain.uptime_url]?.status === 'success'
                            ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800'
                            : speedTestResults[domain.uptime_url]?.status === 'error'
                            ? 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800'
                            : 'bg-muted/50 border-border'
                        }`}
                      >
                        <Globe className="h-3 w-3 flex-shrink-0" />
                        <span className="flex-1 truncate font-mono text-xs">
                          {domain.uptime_url}
                        </span>
                        {speedTestResults[domain.uptime_url]?.status === 'testing' ? (
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <div className="h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            <span>Testing...</span>
                          </div>
                        ) : speedTestResults[domain.uptime_url]?.status === 'success' ? (
                          <div className="flex items-center gap-1 text-green-600 dark:text-green-400">
                            <CheckCircle className="h-3 w-3" />
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {speedTestResults[domain.uptime_url]?.responseTime}ms
                            </span>
                          </div>
                        ) : speedTestResults[domain.uptime_url]?.status === 'error' ? (
                          <div className="flex items-center gap-1 text-red-600 dark:text-red-400">
                            <AlertCircle className="h-3 w-3" />
                            <span className="text-xs">{speedTestResults[domain.uptime_url]?.error || 'Error'}</span>
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              testUrlSpeed(domain.uptime_url);
                            }}
                            disabled={testingUrls.has(domain.uptime_url)}
                          >
                            <Gauge className="h-3 w-3 mr-1" />
                            Test
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Inner Pages Test Results */}
                    {(domain.inner_pages || []).length > 0 && (
                      <div className="space-y-1">
                        {(domain.inner_pages || []).map((url, index) => (
                          <div
                            key={index}
                            className={`flex items-center gap-2 p-2 rounded-md text-xs border ${
                              speedTestResults[url]?.status === 'success'
                                ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800'
                                : speedTestResults[url]?.status === 'error'
                                ? 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800'
                                : 'bg-muted/50 border-border'
                            }`}
                          >
                            <LinkIcon className="h-3 w-3 flex-shrink-0" />
                            <span className="flex-1 truncate font-mono text-xs">{url}</span>
                            {speedTestResults[url]?.status === 'testing' ? (
                              <div className="flex items-center gap-1 text-muted-foreground">
                                <div className="h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                <span>Testing...</span>
                              </div>
                            ) : speedTestResults[url]?.status === 'success' ? (
                              <div className="flex items-center gap-1 text-green-600 dark:text-green-400">
                                <CheckCircle className="h-3 w-3" />
                                <span className="flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  {speedTestResults[url]?.responseTime}ms
                                </span>
                              </div>
                            ) : speedTestResults[url]?.status === 'error' ? (
                              <div className="flex items-center gap-1 text-red-600 dark:text-red-400">
                                <AlertCircle className="h-3 w-3" />
                                <span className="text-xs">{speedTestResults[url]?.error || 'Error'}</span>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 p-0"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    testUrlSpeed(url);
                                  }}
                                  disabled={testingUrls.has(url)}
                                  title="Test Speed"
                                >
                                  <Gauge className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 p-0 text-red-600 hover:text-red-700"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeUrl(domain.id, index);
                                  }}
                                  title="Remove URL"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="pt-2 border-t">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full"
                      onClick={(e) => {
                        e.stopPropagation();
                        openAddUrlModal(domain.id);
                      }}
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add URL
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add URL Modal */}
      {openModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Add URLs for Speed Test</CardTitle>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={closeModal}
                  className="h-6 w-6"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <CardDescription>
                Add URLs or inner pages to test for{" "}
                {domains.find((d) => d.id === openModal)?.display_name ||
                  domains.find((d) => d.id === openModal)?.domain_name}
                <br />
                <span className="text-xs mt-1 block">
                  Enter one URL at a time and click Add
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {/* Single URL Input */}
                <div>
                  <label className="text-sm font-medium mb-2 block">
                    Add URL
                  </label>
                  <div className="flex gap-2">
                    <Input
                      type="url"
                      placeholder="https://example.com/page"
                      value={newUrl}
                      onChange={(e) => {
                        setNewUrl(e.target.value);
                        setError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (newUrl.trim() && openModal) {
                            addSingleUrl(openModal, newUrl.trim());
                          }
                        }
                      }}
                      className="flex-1"
                    />
                    <Button
                      onClick={() => {
                        if (newUrl.trim() && openModal) {
                          addSingleUrl(openModal, newUrl.trim());
                        }
                      }}
                      disabled={!newUrl.trim() || (openModal ? addingUrls.has(newUrl.trim()) : false)}
                    >
                      {openModal && addingUrls.has(newUrl.trim()) ? (
                        <span className="flex items-center gap-1">
                          <div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Adding...
                        </span>
                      ) : (
                        <>
                          <Plus className="h-4 w-4 mr-2" />
                          Add
                        </>
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Enter one URL at a time and click Add
                  </p>
                </div>

                {/* List of Added URLs */}
                {(() => {
                  const domain = domains.find((d) => d.id === openModal);
                  const existingUrls = domain?.inner_pages || [];
                  
                  if (existingUrls.length === 0) return null;
                  
                  return (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-foreground">
                        Added URLs ({existingUrls.length}):
                      </p>
                      <div className="space-y-2 max-h-64 overflow-y-auto border rounded-md p-2">
                        {existingUrls.map((url, idx) => (
                          <div
                            key={idx}
                            className="flex items-center gap-2 p-2 rounded-md bg-muted/50"
                          >
                            <LinkIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <span className="flex-1 text-xs font-mono truncate">
                              {url}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => removeUrl(openModal!, idx)}
                              className="flex-shrink-0 h-7 w-7 p-0 text-red-600 hover:text-red-700"
                              title="Remove URL"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {error && (
                  <div className="p-3 bg-red-50 dark:bg-red-900/10 rounded-md border border-red-200 dark:border-red-800">
                    <div className="text-xs text-red-600 dark:text-red-400 whitespace-pre-line">
                      {error}
                    </div>
                  </div>
                )}
                <div className="flex gap-2">
                  <Button variant="outline" onClick={closeModal} className="w-full">
                    Close
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

