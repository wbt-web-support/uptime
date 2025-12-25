"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import StatusCard from "@/components/StatusCard";
import DashboardHeader from "@/components/DashboardHeader";
import StatsOverview from "@/components/StatsOverview";
import LoadingSpinner from "@/components/LoadingSpinner";
import { AlertTriangle, Grid, List, Clock, Lock, Globe, Server, ExternalLink } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

interface Domain {
  id: string;
  domain_name: string;
  display_name: string | null;
  uptime_url: string;
  category?: string;
  tag?: string;
}

interface UptimeInfo {
  id: string;
  domain_id: string;
  status: boolean;
  checked_at: string;
}

interface SSLInfo {
  id: string;
  domain_id: string;
  expiry_date: string;
  days_remaining: number;
  checked_at: string;
}

interface DomainExpiry {
  id: string;
  domain_id: string;
  expiry_date: string;
  days_remaining: number;
  checked_at: string;
}

interface IPInfo {
  id: string;
  domain_id: string;
  primary_ip: string;
  checked_at: string;
}

interface DomainWithStatus extends Domain {
  uptime?: UptimeInfo;
  ssl?: SSLInfo;
  domain_expiry?: DomainExpiry;
  ip_records?: IPInfo;
}

export default function PublicDashboard() {
  const [domains, setDomains] = useState<DomainWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "domain" | "status">("domain");
  const supabase = createClient();

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

  const fetchDomains = async () => {
    setLoading(true);
    try {
      // Get all domains
      const { data: domainsData, error: domainsError } = await supabase
        .from("domains")
        .select("*");

      if (domainsError) throw domainsError;

      if (!domainsData || domainsData.length === 0) {
        setDomains([]);
        setLoading(false);
        return;
      }

      // Get latest uptime status for each domain
      const domainIds = domainsData.map(domain => domain.id);

      const { data: uptimeData, error: uptimeError } = await supabase
        .from('uptime_logs')
        .select('*')
        .in('domain_id', domainIds)
        .order('checked_at', { ascending: false });

      if (uptimeError) throw uptimeError;

      // Get latest SSL info for each domain
      const { data: sslData, error: sslError } = await supabase
        .from('ssl_info')
        .select('*')
        .in('domain_id', domainIds)
        .order('checked_at', { ascending: false });

      if (sslError) throw sslError;

      // Get latest domain expiry info for each domain
      const { data: expiryData, error: expiryError } = await supabase
        .from('domain_expiry')
        .select('*')
        .in('domain_id', domainIds)
        .order('checked_at', { ascending: false });

      if (expiryError) throw expiryError;

      // Get latest IP records for each domain
      const { data: ipData, error: ipError } = await supabase
        .from('ip_records')
        .select('*')
        .in('domain_id', domainIds)
        .order('checked_at', { ascending: false });

      if (ipError) throw ipError;

      // Combine all data
      const domainsWithStatus = domainsData.map(domain => {
        // Get the latest uptime record for this domain
        const latestUptime = uptimeData?.find(log => log.domain_id === domain.id);
        // Get the latest SSL info for this domain
        const latestSSL = sslData?.find(ssl => ssl.domain_id === domain.id);
        // Get the latest domain expiry info for this domain
        const latestExpiry = expiryData?.find(exp => exp.domain_id === domain.id);
        // Get the latest IP record for this domain
        const latestIP = ipData?.find(ip => ip.domain_id === domain.id);

        return {
          ...domain,
          uptime: latestUptime,
          ssl: latestSSL,
          domain_expiry: latestExpiry,
          ip_records: latestIP
        };
      });

      setDomains(domainsWithStatus);
    } catch (err: any) {
      console.error("Error fetching data:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDomains();

    // Set up polling every 30 seconds
    const intervalId = setInterval(fetchDomains, 30000);

    // Clean up interval on component unmount
    return () => clearInterval(intervalId);
  }, []);

  // Get all unique categories from domains
  const categories = ["all", ...Array.from(new Set(domains
    .filter(domain => domain.category)
    .map(domain => domain.category as string)
  ))];

  // Filter and sort domains based on search query, status filter, and sort choice
  const filteredDomains = domains.filter(domain => {
    const matchesSearch =
      domain.domain_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      searchQuery.toLowerCase().includes(domain.domain_name.toLowerCase()) ||
      (domain.display_name && domain.display_name.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (domain.uptime_url && domain.uptime_url.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'up' && domain.uptime?.status === true) ||
      (statusFilter === 'down' && domain.uptime?.status === false) ||
      (statusFilter === 'ssl-expiring' && (domain.ssl?.days_remaining ?? 999) <= 15) ||
      (statusFilter === 'domain-expiring' && (domain.domain_expiry?.days_remaining ?? 999) <= 30);

    const matchesCategory =
      categoryFilter === 'all' ||
      domain.category === categoryFilter;

    return matchesSearch && matchesStatus && matchesCategory;
  }).sort((a, b) => {
    switch (sortBy) {
      case "newest":
        return new Date(b.uptime?.checked_at || 0).getTime() - new Date(a.uptime?.checked_at || 0).getTime();
      case "oldest":
        return new Date(a.uptime?.checked_at || 0).getTime() - new Date(b.uptime?.checked_at || 0).getTime();
      case "domain":
        return (a.display_name || a.domain_name).localeCompare(b.display_name || b.domain_name);
      case "status":
        // Sort by status (up first, then down, then unknown)
        const aStatus = a.uptime?.status;
        const bStatus = b.uptime?.status;
        if (aStatus === bStatus) return 0;
        if (aStatus === true) return -1;
        if (bStatus === true) return 1;
        if (aStatus === false) return -1;
        return 1;
      default:
        return 0;
    }
  });

  // Calculate stats for DashboardHeader
  const stats = {
    total: domains.length,
    up: domains.filter(d => d.uptime?.status === true).length,
    down: domains.filter(d => d.uptime?.status === false).length,
    sslExpiring: domains.filter(d => d.ssl?.days_remaining !== undefined && d.ssl.days_remaining <= 15).length,
    domainExpiring: domains.filter(d => d.domain_expiry?.days_remaining !== undefined && d.domain_expiry.days_remaining <= 30).length
  };

  // Calculate category counts
  const categoryStats: Record<string, number> = {
    all: domains.length
  };

  domains.forEach(domain => {
    if (domain.category) {
      categoryStats[domain.category] = (categoryStats[domain.category] || 0) + 1;
    }
  });

  return (
    <div className="container mx-auto py-0 px-0">
      <DashboardHeader
        title="Domain Status"
        description="Monitor the status of domains, SSL certificates, and domain expiry dates"
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        categoryFilter={categoryFilter}
        setCategoryFilter={setCategoryFilter}
        categories={categories}
        totalCount={domains.length}
        filteredCount={filteredDomains.length}
        stats={stats}
        categoryStats={categoryStats}
        sortBy={sortBy}
        setSortBy={setSortBy as any}
        viewMode={viewMode}
        setViewMode={setViewMode}
      />

      {/* {domains.length > 0 && <StatsOverview domains={domains} />} */}

      {error && (
        <div className="card border-red-300 mb-6 bg-red-50 dark:bg-red-900/10">
          <div className="flex items-center gap-3 text-red-700 dark:text-red-400">
            <AlertTriangle size={18} />
            <p>{error}</p>
          </div>
        </div>
      )}

      {loading && domains.length === 0 ? (
        <div className="py-20">
          <LoadingSpinner size="lg" />
        </div>
      ) : domains.length === 0 ? (
        <div className="card text-center py-16">
          <h3 className="text-xl font-medium mb-2">No domains found</h3>
          <p className="text-muted-foreground">
            There are no domains registered in the system. Check back later or contact the administrator.
          </p>
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 mt-6">
          {filteredDomains.map((domain) => (
            <StatusCard key={domain.id} domain={domain} />
          ))}
        </div>
      ) : (
        <div className="mt-6">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Domain</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Last Check</th>
                  <th className="px-4 py-3 text-left font-medium">SSL Expires</th>
                  <th className="px-4 py-3 text-left font-medium">Domain Expires</th>
                  <th className="px-4 py-3 text-left font-medium">Category</th>
                  <th className="px-4 py-3 text-left font-medium">IP / Server</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredDomains.map((domain) => (
                  <tr key={domain.id} className="hover:bg-muted/20">
                    <td className="px-4 py-4">
                      <div>
                        <div className="font-medium text-base">{domain.display_name || domain.domain_name}</div>
                        <a
                          href={domain.uptime_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-muted-foreground hover:text-brand flex items-center gap-1 mt-1"
                        >
                          <Globe size={14} />
                          {domain.domain_name}
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      {!domain.uptime ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                          <span className="status-indicator status-unknown mr-1"></span>
                          Unknown
                        </span>
                      ) : domain.uptime.status ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                          <span className="status-indicator status-up mr-1"></span>
                          Operational
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                          <span className="status-indicator status-down mr-1"></span>
                          Down
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <Clock className="text-brand h-4 w-4" />
                        <span className="text-sm">
                          {!domain.uptime?.checked_at ? "Never" :
                            formatTimeAgo(domain.uptime.checked_at)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <Lock className="text-brand h-4 w-4" />
                        {!domain.ssl ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                            Unknown
                          </span>
                        ) : domain.ssl.days_remaining < 0 ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                            Expired {Math.abs(domain.ssl.days_remaining)} days ago
                          </span>
                        ) : domain.ssl.days_remaining <= 7 ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                            {domain.ssl.days_remaining} days
                          </span>
                        ) : domain.ssl.days_remaining <= 30 ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                            {domain.ssl.days_remaining} days
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                            {domain.ssl.days_remaining} days
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <Globe className="text-brand h-4 w-4" />
                        {!domain.domain_expiry ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                            Unknown
                          </span>
                        ) : domain.domain_expiry.days_remaining < 0 ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                            Expired {Math.abs(domain.domain_expiry.days_remaining)} days ago
                          </span>
                        ) : domain.domain_expiry.days_remaining <= 7 ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                            {domain.domain_expiry.days_remaining} days
                          </span>
                        ) : domain.domain_expiry.days_remaining <= 30 ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                            {domain.domain_expiry.days_remaining} days
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                            {domain.domain_expiry.days_remaining} days
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      {domain.category ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium  text-blue-800  dark:text-blue-300">
                          {domain.category}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">Not set</span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <Server className="text-brand h-4 w-4" />
                        {!domain.ip_records?.primary_ip ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                            Unknown
                          </span>
                        ) : (
                          <div className="group relative">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 font-mono">
                              {domain.ip_records.primary_ip}
                            </span>
                            {/* Show server name and tag on hover */}
                            {(domain.tag || getTagFromIP(domain.ip_records.primary_ip)) && (
                              <div className="absolute left-0 mt-1 hidden group-hover:block z-10">
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 whitespace-nowrap">
                                  {domain.tag || getTagFromIP(domain.ip_records.primary_ip)}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <a
                        href={`/domain/${domain.domain_name}`}
                        className="btn-outline text-xs py-1.5"
                      >
                        See Details
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(dateString: string) {
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
} 