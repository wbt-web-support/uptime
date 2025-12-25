"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import EmbedInfo from "@/components/EmbedInfo";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { ChevronLeft, ExternalLink, Globe, Lock, Clock, CheckCircle, XCircle, Image as ImageIcon, Server, Tag, ListFilter } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface DomainPageProps {
  params: {
    domain: string;
  };
}

// Define interface for graph data
interface GraphDataPoint {
  time: string;
  date: string;
  status: number;
  responseTime: number;
}

export default function DomainPage({ params }: DomainPageProps) {
  const { domain } = params;
  const [loading, setLoading] = useState(true);
  const [domainData, setDomainData] = useState<any>(null);
  const [error, setError] = useState("");
  const supabase = createClient();
  const [siteImage, setSiteImage] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    const fetchDomainInfo = async () => {
      setLoading(true);
      try {
        // Find the domain
        const { data: domainResults, error: domainError } = await supabase
          .from("domains")
          .select("*")
          .eq("domain_name", domain)
          .single();

        if (domainError) throw domainError;
        if (!domainResults) throw new Error("Domain not found");

        // Get latest uptime status
        const { data: uptimeData } = await supabase
          .from("uptime_logs")
          .select("*")
          .eq("domain_id", domainResults.id)
          .order("checked_at", { ascending: false })
          .limit(1)
          .single();

        // Get latest SSL info
        const { data: sslData } = await supabase
          .from("ssl_info")
          .select("*")
          .eq("domain_id", domainResults.id)
          .order("checked_at", { ascending: false })
          .limit(1)
          .single();

        // Get latest domain expiry info
        const { data: expiryData } = await supabase
          .from("domain_expiry")
          .select("*")
          .eq("domain_id", domainResults.id)
          .order("checked_at", { ascending: false })
          .limit(1)
          .single();

        // Get latest IP records
        const { data: ipData } = await supabase
          .from("ip_records")
          .select("*")
          .eq("domain_id", domainResults.id)
          .order("checked_at", { ascending: false })
          .limit(1)
          .single();

        // Get recent uptime history (last 50 entries for the graph)
        const { data: uptimeHistory } = await supabase
          .from("uptime_logs")
          .select("*")
          .eq("domain_id", domainResults.id)
          .order("checked_at", { ascending: true })
          .limit(50);

        setDomainData({
          ...domainResults,
          uptime: uptimeData,
          ssl: sslData,
          domain_expiry: expiryData,
          ip_records: ipData,
          uptime_history: uptimeHistory || []
        });
      } catch (err: any) {
        console.error("Error fetching domain info:", err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchDomainInfo();

    // Set up refresh interval
    const intervalId = setInterval(fetchDomainInfo, 30000);
    return () => clearInterval(intervalId);
  }, [domain]);

  // Fetch site preview image
  useEffect(() => {
    if (domainData?.uptime_url) {
      const fetchSiteImage = async () => {
        setImageLoading(true);
        try {
          const url = domainData.uptime_url;
          // Try to fetch the metadata via proxy to avoid CORS issues
          const response = await fetch(`/api/site-preview?url=${encodeURIComponent(url)}`);

          if (response.ok) {
            const data = await response.json();
            if (data.ogImage) {
              setSiteImage(data.ogImage);
            } else {
              // If no OG image, try favicon
              setSiteImage(`https://www.google.com/s2/favicons?domain=${url}&sz=128`);
            }
          } else {
            // Fallback to favicon
            setSiteImage(`https://www.google.com/s2/favicons?domain=${url}&sz=128`);
          }
        } catch (error) {
          console.error("Error fetching site image:", error);
          setImageError(true);
          // Fallback to favicon
          setSiteImage(`https://www.google.com/s2/favicons?domain=${domainData.uptime_url}&sz=128`);
        } finally {
          setImageLoading(false);
        }
      };

      fetchSiteImage();
    }
  }, [domainData]);

  const formatDate = (dateString?: string) => {
    if (!dateString) return "Unknown";
    return new Date(dateString).toLocaleDateString();
  };

  const formatTimeAgo = (dateString?: string) => {
    if (!dateString) return "Never";

    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHour / 24);

    if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    if (diffHour > 0) return `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
    if (diffMin > 0) return `${diffMin} minute${diffMin > 1 ? 's' : ''} ago`;
    return `${diffSec} second${diffSec !== 1 ? 's' : ''} ago`;
  };

  // Get status badge
  const getStatusBadge = (status: boolean) => {
    return status ? (
      <Badge className="bg-brand text-white px-3 py-1 flex items-center gap-1 max-w-36">
        <CheckCircle size={14} className="text-white" />
        Operational
      </Badge>
    ) : (
      <Badge className="bg-red-500 text-white px-3 py-1 flex items-center gap-1">
        <XCircle size={14} className="text-white" />
        Down
      </Badge>
    );
  };

  // Function to determine tag based on IP address
  const getTagFromIP = (ip: string) => {
    if (!ip) return null;

    const ipMappings: Record<string, string> = {
      "91.204.209.205": "uranium Direct Admin",
      "91.204.209.204": "iridium Direct Admin",
      "109.70.148.64": "cPanel draftforclients.com",
      "91.204.209.29": "cPanel webuildtrades.com",
      "91.204.209.39": "cPanel webuildtrades.io",
      "35.214.4.69": "SiteGround",
      "165.22.127.156": "Cloudways",
      "64.227.39.249": "Digitalocean"
    };

    return ipMappings[ip] || null;
  };

  if (loading) {
    return (
      <div className="container mx-auto py-8 px-4">
        <div className="flex items-center mb-6">
          <Skeleton className="h-10 w-40 mr-4" />
          <Skeleton className="h-10 w-60" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          {[...Array(5)].map((_, i) => (
            <Card key={i} className="p-6">
              <Skeleton className="h-6 w-32 mb-4" />
              <div className="space-y-3">
                <div className="flex justify-between"><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-12" /></div>
                <div className="flex justify-between"><Skeleton className="h-4 w-24" /><Skeleton className="h-4 w-16" /></div>
                <div className="flex justify-between"><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-12" /></div>
              </div>
            </Card>
          ))}
        </div>
        <Card className="mb-8 p-6">
          <Skeleton className="h-6 w-48 mb-4" />
          <div className="space-y-4">
            <div className="bg-muted h-10 w-full rounded" />
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  if (error || !domainData) {
    return (
      <div className="container mx-auto py-8 px-4">
        <div className="card border-red-300 mb-6 bg-red-50 dark:bg-red-900/10">
          <div className="flex items-center gap-3 text-red-700 dark:text-red-400">
            <XCircle size={18} />
            <p>{error || "Domain not found"}</p>
          </div>
        </div>
        <Link href="/" className="btn-outline flex items-center gap-2 w-fit">
          <ChevronLeft size={16} />
          Back to Dashboard
        </Link>
      </div>
    );
  }

  // Update the graphData assignment
  const graphData: GraphDataPoint[] = domainData.uptime_history.map((log: any) => ({
    time: new Date(log.checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    date: new Date(log.checked_at).toLocaleDateString(),
    status: log.status ? 1 : 0,
    responseTime: log.response_time || 0
  }));

  // Update the max response time calculation
  const maxResponseTime = Math.max(...graphData.map((d: GraphDataPoint) => d.responseTime), 1000);

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="flex items-center mb-6">
        <Link href="/" className="btn-outline flex items-center gap-2 mr-4">
          <ChevronLeft size={16} />
          Back to Dashboard
        </Link>
        <h1 className="text-3xl font-bold">Domain Details</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8 hidden">
        {/* Website URL Card */}
        <div className="card">
          <div className="card-header border-b border-border pb-4">
            <h2 className="card-title">Website URL</h2>
            <p className="card-description">The monitored URL for this domain</p>
          </div>

          <div className="p-6">
            <div className="flex gap-4">
              {/* Website Image/Icon */}
              {imageLoading ? (
                <div className="w-20 h-20 bg-secondary/30 rounded-md flex items-center justify-center shrink-0">
                  <Skeleton className="h-full w-full rounded-md" />
                </div>
              ) : siteImage ? (
                <img
                  src={siteImage}
                  alt={`${domainData.display_name || domainData.domain_name} preview`}
                  className="w-20 h-20 object-contain rounded-md shadow-sm shrink-0"
                  onError={() => setImageError(true)}
                />
              ) : (
                <div className="w-20 h-20 bg-secondary/30 rounded-md flex items-center justify-center shrink-0">
                  <ImageIcon className="text-muted-foreground h-10 w-10" />
                </div>
              )}

              {/* Website Details */}
              <div className="flex flex-col justify-between">
                <a
                  href={domainData.uptime_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand hover:underline flex items-center gap-1 font-medium"
                >
                  {domainData.uptime_url}
                  <ExternalLink size={14} />
                </a>

                <div className="mt-2">
                  <div className="flex gap-2 items-center">
                    <span className="text-sm text-muted-foreground">Status:</span>
                    {getStatusBadge(domainData.uptime?.status || false)}
                  </div>

                  <div className="mt-1 text-sm text-muted-foreground">
                    Last checked: {formatTimeAgo(domainData.uptime?.checked_at)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Status Badge Card */}
        <div className="card">
          <div className="card-header border-b border-border pb-4">
            <h2 className="card-title">Status Badge</h2>
            <p className="card-description">Share your domain's status on your website</p>
          </div>

          <div className="p-6">
            <EmbedInfo domain={domainData.domain_name} />
          </div>
        </div>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            {domainData.uptime?.status ?
              <CheckCircle className="text-brand h-5 w-5" /> :
              <XCircle className="text-red-500 h-5 w-5" />
            }
            <h3 className="font-semibold">Uptime Status</h3>
          </div>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Status:</span>
              <span className="font-medium">{getStatusBadge(domainData.uptime?.status || false)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Last checked:</span>
              <span className="font-medium">{formatTimeAgo(domainData.uptime?.checked_at)}</span>
            </div>
            {domainData.uptime?.response_time && (
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Response time:</span>
                <span className="font-medium">{domainData.uptime.response_time} ms</span>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Lock className="text-brand h-5 w-5" />
            <h3 className="font-semibold">SSL Certificate</h3>
          </div>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Expires:</span>
              <span className="font-medium">{formatDate(domainData.ssl?.expiry_date)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Days remaining:</span>
              <span className={`font-medium ${!domainData.ssl ? "text-muted-foreground" :
                domainData.ssl.days_remaining < 0 ? "text-red-500" :
                  domainData.ssl.days_remaining <= 10 ? "text-red-500" :
                    domainData.ssl.days_remaining <= 30 ? "text-amber-500" :
                      "text-brand"
                }`}>
                {!domainData.ssl ? "Unknown" :
                  domainData.ssl.days_remaining < 0 ? `Expired ${Math.abs(domainData.ssl.days_remaining)} days ago` :
                    `${domainData.ssl.days_remaining} days`}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Issuer:</span>
              <span className="font-medium">{domainData.ssl?.issuer || "Unknown"}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="text-brand h-5 w-5" />
            <h3 className="font-semibold">Domain Registration</h3>
          </div>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Expires:</span>
              <span className="font-medium">{formatDate(domainData.domain_expiry?.expiry_date)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Days remaining:</span>
              <span className={`font-medium ${!domainData.domain_expiry ? "text-muted-foreground" :
                domainData.domain_expiry.days_remaining < 0 ? "text-red-500" :
                  domainData.domain_expiry.days_remaining <= 10 ? "text-red-500" :
                    domainData.domain_expiry.days_remaining <= 30 ? "text-amber-500" :
                      "text-brand"
                }`}>
                {!domainData.domain_expiry ? "Unknown" :
                  domainData.domain_expiry.days_remaining < 0 ? `Expired ${Math.abs(domainData.domain_expiry.days_remaining)} days ago` :
                    `${domainData.domain_expiry.days_remaining} days`}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Registrar:</span>
              <span className="font-medium">{domainData.domain_expiry?.registrar || "Unknown"}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <ListFilter className="text-brand h-5 w-5" />
            <h3 className="font-semibold">Category</h3>
          </div>
          <div className="space-y-3">
            <div className="flex flex-col justify-between items-start">
              <span className="text-sm text-muted-foreground">Category:</span>
              {domainData.category ? (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                  {domainData.category}
                </span>
              ) : (
                <span className="text-muted-foreground">Not set</span>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Server className="text-brand h-5 w-5" />
            <h3 className="font-semibold">Server</h3>
          </div>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Primary IP:</span>
              <span className="font-medium">{domainData.ip_records?.primary_ip || "Unknown"}</span>
            </div>
            {domainData.ip_records?.primary_ip && getTagFromIP(domainData.ip_records.primary_ip) && (
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Server Type:</span>
                {domainData.tag ? (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                    {domainData.tag}
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                    {getTagFromIP(domainData.ip_records.primary_ip)}
                  </span>
                )}
              </div>
            )}
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Last checked:</span>
              <span className="font-medium">{formatTimeAgo(domainData.ip_records?.checked_at)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Nameservers:</span>
              <span className="font-medium">{domainData.ip_records?.nameservers?.length || 0}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Uptime History Table */}
      <div className="card mb-8">
        <div className="card-header border-b border-border pb-4">
          <h2 className="card-title">Detailed Uptime History</h2>
          <p className="card-description">Recent uptime check records</p>
        </div>

        <div className="p-6">
          {domainData.uptime_history.length === 0 ? (
            <div className="text-center py-8 bg-secondary/30 rounded-md">
              <p className="text-muted-foreground">No uptime data available yet</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Time</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Response Time</th>
                    <th className="px-4 py-3 text-left font-medium">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[...domainData.uptime_history].reverse().map((log: any) => (
                    <tr key={log.id} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        {new Date(log.checked_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        {getStatusBadge(log.status)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {log.response_time ? `${log.response_time} ms` : "-"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {log.error_message || "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Uptime Graph */}
      <div className="card mb-8">
        <div className="card-header border-b border-border pb-4">
          <h2 className="card-title">Uptime History</h2>
          <p className="card-description">Visualization of recent uptime checks</p>
        </div>

        <div className="p-6">
          {domainData.uptime_history.length === 0 ? (
            <div className="text-center py-12 bg-secondary/30 rounded-md">
              <p className="text-muted-foreground">No uptime data available yet</p>
            </div>
          ) : (
            <div className="h-60 w-full">
              <div className="w-full h-full flex flex-col">
                {/* Graph Header */}
                <div className="flex justify-between text-xs text-muted-foreground mb-2">
                  <span>Response Time (ms)</span>
                  <span>Status</span>
                </div>

                {/* Graph Container */}
                <div className="flex-1 relative border-l border-b border-border">
                  {/* Y-axis labels for response time */}
                  <div className="absolute left-0 top-0 h-full flex flex-col justify-between text-xs text-muted-foreground">
                    <span className="-translate-x-2 -translate-y-2">
                      {Math.max(...graphData.map(d => d.responseTime), 1000)}
                    </span>
                    <span className="-translate-x-2">
                      {Math.max(...graphData.map(d => d.responseTime), 1000) / 2}
                    </span>
                    <span className="-translate-x-2 translate-y-2">0</span>
                  </div>

                  {/* Graph bars */}
                  <div className="absolute left-5 right-0 top-0 bottom-0 flex items-end">
                    {graphData.map((data: GraphDataPoint, index: number) => {
                      const height = data.responseTime ? (data.responseTime / maxResponseTime) * 100 : 0;
                      return (
                        <div
                          key={index}
                          className="flex flex-col items-center group"
                          style={{
                            width: `${100 / graphData.length}%`,
                            height: '100%'
                          }}
                        >
                          {/* Status indicator */}
                          <div
                            className={`w-full h-1 mb-1 ${data.status ? 'bg-brand' : 'bg-red-500'}`}
                          ></div>

                          {/* Response time bar */}
                          <div
                            className={`w-4/5 ${data.status ? 'bg-brand/50' : 'bg-red-500/30'}`}
                            style={{ height: `${height}%` }}
                          ></div>

                          {/* Tooltip */}
                          <div className="absolute bottom-full opacity-0 group-hover:opacity-100 bg-background shadow-md rounded-md p-2 text-xs pointer-events-none transition-opacity z-10 mb-2">
                            <p>Time: {data.time}</p>
                            <p>Date: {data.date}</p>
                            <p>Status: {data.status ? 'Up' : 'Down'}</p>
                            <p>Response: {data.responseTime} ms</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* X-axis labels */}
                <div className="flex justify-between mt-1 text-xs text-muted-foreground overflow-hidden">
                  {graphData.length > 0 && (
                    <>
                      <span>{graphData[0].time}</span>
                      {graphData.length > 2 && (
                        <span>{graphData[Math.floor(graphData.length / 2)].time}</span>
                      )}
                      <span>{graphData[graphData.length - 1].time}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
} 