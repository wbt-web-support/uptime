"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { signOutAction } from "@/app/actions";
import StatusCard from "@/components/StatusCard";
import DomainForm from "@/components/DomainForm";
import DashboardHeader from "@/components/DashboardHeader";
import StatsOverview from "@/components/StatsOverview";
import DomainActions from "@/components/DomainActions";
import LoadingSpinner from "@/components/LoadingSpinner";
import { AlertTriangle, Clock, CheckCircle, RefreshCw, Activity, Shield, Globe, Server, ExternalLink, Trash2, ArrowUp, ArrowDown, ChevronsUpDown } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

export default function AdminPanel() {
  const [domains, setDomains] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [checkInterval, setCheckInterval] = useState("daily");
  const [checkingAll, setCheckingAll] = useState(false);
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "domain" | "status" | "ssl-asc" | "ssl-desc" | "expiry-asc" | "expiry-desc">("domain");
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [selectAll, setSelectAll] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>("Live Website");
  const [checkResults, setCheckResults] = useState<{
    successes: number;
    failures: number;
    total: number;
  }>({ successes: 0, failures: 0, total: 0 });
  const [checkingDomain, setCheckingDomain] = useState<string | null>(null);
  const supabase = createClient();

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
        // Get the latest IP records for this domain
        const latestIp = ipData?.find(ip => ip.domain_id === domain.id);

        return {
          ...domain,
          uptime: latestUptime,
          ssl: latestSSL,
          domain_expiry: latestExpiry,
          ip_records: latestIp
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
  }, []);

  const deleteDomain = async (id: string) => {
    setLoading(true);
    try {
      const { error } = await supabase.from("domains").delete().eq("id", id);
      
      if (error) throw error;
      
      setSuccess("Domain deleted successfully!");
      fetchDomains();
    } catch (error: any) {
      setError(error.message);
      setLoading(false);
    }
  };
  
  const saveCheckInterval = async () => {
    // In a production app, you might save this to a settings table in Supabase
    setSuccess(`Monitoring interval set to ${checkInterval}`);
  };

  const checkAllDomains = async () => {
    if (domains.length === 0) return;
    
    setCheckingAll(true);
    setSuccess(""); // Clear any previous messages
    setError("");
    
    let successes = 0;
    let failures = 0;
    
    try {
      // Process each domain
      for (const domain of domains) {
        try {
          // Check uptime
          await fetch('/api/check/uptime', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domainId: domain.id, url: domain.uptime_url })
          });
          
          // Check SSL
          await fetch('/api/check/ssl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domainId: domain.id, domain: domain.domain_name })
          });
          
          // Check domain expiry
          await fetch('/api/check/whois', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domainId: domain.id, domain: domain.domain_name })
          });
          
          // Check IP records
          await fetch('/api/check/ip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domainId: domain.id, domain: domain.domain_name })
          });
          
          successes++;
        } catch (err) {
          failures++;
          console.error(`Error checking domain ${domain.domain_name}:`, err);
        }
      }
      
      // Update stats and fetch fresh data
      setCheckResults({
        successes,
        failures,
        total: domains.length
      });
      
      setSuccess(`Domain checks completed: ${successes} successful, ${failures} failed`);
      fetchDomains(); // Refresh data
      
    } catch (err: any) {
      setError("Error during batch domain check: " + err.message);
    } finally {
      setCheckingAll(false);
    }
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

  // Get all unique categories from domains
  const categories = ["all", ...Array.from(new Set(domains
    .filter(domain => domain.category)
    .map(domain => domain.category)
  ))];

  // Filter domains based on search query and status filter
  const filteredDomains = domains.filter(domain => {
    const matchesSearch = 
      domain.domain_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (domain.display_name && domain.display_name.toLowerCase().includes(searchQuery.toLowerCase()));
    
    const matchesStatus = 
      statusFilter === 'all' || 
      (statusFilter === 'up' && domain.uptime?.status === true) ||
      (statusFilter === 'down' && domain.uptime?.status === false) ||
      (statusFilter === 'ssl-expiring' && (domain.ssl?.days_remaining ?? 999) <= 30) ||
      (statusFilter === 'domain-expiring' && (domain.domain_expiry?.days_remaining ?? 999) <= 30);
    
    const matchesCategory = 
      categoryFilter === 'all' || 
      domain.category === categoryFilter;
    
    return matchesSearch && matchesStatus && matchesCategory;
  }).sort((a, b) => {
    switch(sortBy) {
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
      case "ssl-asc":
        // Sort SSL by days remaining (ascending - lowest first)
        const aSslDays = a.ssl?.days_remaining ?? 999;
        const bSslDays = b.ssl?.days_remaining ?? 999;
        return aSslDays - bSslDays;
      case "ssl-desc":
        // Sort SSL by days remaining (descending - highest first)
        const aSslDaysDesc = a.ssl?.days_remaining ?? 999;
        const bSslDaysDesc = b.ssl?.days_remaining ?? 999;
        return bSslDaysDesc - aSslDaysDesc;
      case "expiry-asc":
        // Sort Domain Expiry by days remaining (ascending - lowest first)
        const aExpiryDays = a.domain_expiry?.days_remaining ?? 999;
        const bExpiryDays = b.domain_expiry?.days_remaining ?? 999;
        return aExpiryDays - bExpiryDays;
      case "expiry-desc":
        // Sort Domain Expiry by days remaining (descending - highest first)
        const aExpiryDaysDesc = a.domain_expiry?.days_remaining ?? 999;
        const bExpiryDaysDesc = b.domain_expiry?.days_remaining ?? 999;
        return bExpiryDaysDesc - aExpiryDaysDesc;
      default:
        return 0;
    }
  });

  const checkDomain = async (id: string, url: string, domain_name: string) => {
    setCheckingDomain(id);
    setSuccess("");
    setError("");
    
    try {
      setSuccess(`Checking domain: ${domain_name}...`);
      
      // Check uptime
      await fetch('/api/check/uptime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domainId: id, url })
      });
      
      // Check SSL
      await fetch('/api/check/ssl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domainId: id, domain: domain_name })
      });
      
      // Check domain expiry
      await fetch('/api/check/whois', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domainId: id, domain: domain_name })
      });
      
      // Check IP records
      await fetch('/api/check/ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domainId: id, domain: domain_name })
      });
      
      setSuccess(`Domain ${domain_name} checked successfully!`);
      fetchDomains(); // Refresh data
    } catch (err: any) {
      setError(`Error checking domain ${domain_name}: ${err.message}`);
    } finally {
      setCheckingDomain(null);
    }
  };

  const toggleSelectDomain = (id: string) => {
    setSelectedDomains(prev => {
      if (prev.includes(id)) {
        return prev.filter(domainId => domainId !== id);
      } else {
        return [...prev, id];
      }
    });
  };

  const toggleSelectAll = () => {
    const newSelectAll = !selectAll;
    setSelectAll(newSelectAll);
    
    if (newSelectAll) {
      // Select all domains that are currently filtered/visible
      setSelectedDomains(filteredDomains.map(domain => domain.id));
    } else {
      // Deselect all domains
      setSelectedDomains([]);
    }
  };

  const deleteSelectedDomains = async () => {
    if (selectedDomains.length === 0) return;
    
    const confirmDelete = window.confirm(`Are you sure you want to delete ${selectedDomains.length} selected domains?`);
    if (!confirmDelete) return;
    
    setLoading(true);
    try {
      // Delete selected domains
      for (const id of selectedDomains) {
        const { error } = await supabase.from("domains").delete().eq("id", id);
        if (error) throw error;
      }
      
      setSuccess(`${selectedDomains.length} domains deleted successfully!`);
      setSelectedDomains([]);
      setSelectAll(false);
      fetchDomains();
    } catch (error: any) {
      setError(error.message);
      setLoading(false);
    }
  };

  const checkSelectedDomains = async () => {
    if (selectedDomains.length === 0) return;
    
    setLoading(true);
    setSuccess(`Checking ${selectedDomains.length} selected domains...`);
    
    try {
      let successes = 0;
      let failures = 0;
      
      // Get the selected domains from the full domains list
      const domainsToCheck = domains.filter(domain => selectedDomains.includes(domain.id));
      
      // Process each selected domain
      for (const domain of domainsToCheck) {
        try {
          // Check uptime
          await fetch('/api/check/uptime', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domainId: domain.id, url: domain.uptime_url })
          });
          
          // Check SSL
          await fetch('/api/check/ssl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domainId: domain.id, domain: domain.domain_name })
          });
          
          // Check domain expiry
          await fetch('/api/check/whois', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domainId: domain.id, domain: domain.domain_name })
          });
          
          // Check IP records
          await fetch('/api/check/ip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domainId: domain.id, domain: domain.domain_name })
          });
          
          successes++;
        } catch (err) {
          failures++;
          console.error(`Error checking domain ${domain.domain_name}:`, err);
        }
      }
      
      setSuccess(`Domain checks completed: ${successes} successful, ${failures} failed`);
      fetchDomains(); // Refresh data
    } catch (error: any) {
      setError(`Error during batch domain check: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const updateSelectedDomainsCategory = async () => {
    if (selectedDomains.length === 0) return;
    
    setLoading(true);
    try {
      const { error } = await supabase
        .from("domains")
        .update({ category: selectedCategory })
        .in("id", selectedDomains);

      if (error) throw error;
      
      setSuccess(`Category updated to "${selectedCategory}" for ${selectedDomains.length} ${selectedDomains.length === 1 ? 'domain' : 'domains'}!`);
      setTimeout(() => setSuccess(""), 3000);
      fetchDomains(); // Refresh data
    } catch (error: any) {
      setError(error.message);
      setLoading(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto py-8 px-4">
      <DashboardHeader
        title="Admin Panel"
        description="Manage and monitor your domains"
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        categoryFilter={categoryFilter}
        setCategoryFilter={setCategoryFilter}
        categories={categories}
        totalCount={domains.length}
        filteredCount={filteredDomains.length}
        rightContent={
          <div className="flex items-center gap-4">
            <Select 
              value={sortBy} 
              onValueChange={(value) => setSortBy(value as any)}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="domain">Sort by Domain</SelectItem>
                <SelectItem value="newest">Newest First</SelectItem>
                <SelectItem value="oldest">Oldest First</SelectItem>
                <SelectItem value="status">Status</SelectItem>
              </SelectContent>
            </Select>
            
          </div>
        }
      />
     

      {domains.length > 0 && <StatsOverview domains={domains} />}

      {error && (
        <div className="card border-red-300 mb-6 bg-red-50 dark:bg-red-900/10">
          <div className="flex items-center gap-3 text-red-700 dark:text-red-400">
            <AlertTriangle size={18} />
            <p>{error}</p>
          </div>
        </div>
      )}
       <DomainForm onSave={fetchDomains} />

      {success && (
        <div className="card border-green-300 mb-6 bg-green-50 dark:bg-green-900/10">
          <div className="flex items-center gap-3 text-green-700 dark:text-green-400">
            <CheckCircle size={18} />
            <p>{success}</p>
          </div>
        </div>
      )}

      {/* Multiple selection actions */}
      {selectedDomains.length > 0 && (
        <div className="card mb-6 flex items-center justify-between flex-wrap gap-4">
          <div className="text-sm text-muted-foreground">
            <span className="font-medium">{selectedDomains.length}</span> {selectedDomains.length === 1 ? 'domain' : 'domains'} selected
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Select 
                value={selectedCategory} 
                onValueChange={setSelectedCategory}
              >
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Live Website">Live Website</SelectItem>
                  <SelectItem value="Live Website Temporary Suspended">Live Website Temporary Suspended</SelectItem>
                  <SelectItem value="Migration Done">Migration Done</SelectItem>
                  <SelectItem value="Migration Pending">Migration Pending</SelectItem>
                  <SelectItem value="Draft Website">Draft Website</SelectItem>
                  <SelectItem value="Draft Suspended Website">Draft Suspended Website</SelectItem>
                </SelectContent>
              </Select>
              <button 
                onClick={updateSelectedDomainsCategory}
                className="btn btn-secondary flex items-center gap-2"
                disabled={loading}
              >
                Update Category
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button 
                onClick={checkSelectedDomains}
                className="btn btn-secondary flex items-center gap-2"
                disabled={loading}
              >
                <RefreshCw size={16} />
                Check Selected
              </button>
              <button 
                onClick={deleteSelectedDomains}
                className="btn btn-destructive flex items-center gap-2"
                disabled={loading}
              >
                <Trash2 size={16} />
                Delete Selected
              </button>
            </div>
          </div>
        </div>
      )}

      {loading && !checkingAll ? (
        <div className="text-center py-12">
          <LoadingSpinner size="lg" />
          <p className="mt-4 text-muted-foreground">Loading domains...</p>
        </div>
      ) : domains.length === 0 ? (
        <div className="card">
          <div className="text-center py-12">
            <Globe className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-medium mb-2">No Domains Added Yet</h3>
            <p className="text-muted-foreground mb-6">
              Add your first domain to start monitoring
            </p>
            <button 
              onClick={() => document.getElementById('add-domain-form')?.scrollIntoView({ behavior: 'smooth' })}
              className="btn-brand"
            >
              Add First Domain
            </button>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full rounded-md">
            <thead className="text-left bg-muted">
              <tr>
                <th className="p-3 font-medium text-muted-foreground">
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={selectAll}
                      onChange={toggleSelectAll}
                      className="mr-2 h-4 w-4"
                    />
                    <span>Domain Name</span>
                  </div>
                </th>
                <th className="p-3 font-medium text-muted-foreground">Status</th>
                <th className="p-3 font-medium text-muted-foreground">
                  <button
                    onClick={() => setSortBy(sortBy === "ssl-asc" ? "ssl-desc" : "ssl-asc")}
                    className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
                  >
                    SSL
                    {sortBy === "ssl-asc" && <ArrowUp className="h-3 w-3" />}
                    {sortBy === "ssl-desc" && <ArrowDown className="h-3 w-3" />}
                    {sortBy !== "ssl-asc" && sortBy !== "ssl-desc" && (
                      <ChevronsUpDown className="h-3 w-3 opacity-40" />
                    )}
                  </button>
                </th>
                <th className="p-3 font-medium text-muted-foreground">
                  <button
                    onClick={() => setSortBy(sortBy === "expiry-asc" ? "expiry-desc" : "expiry-asc")}
                    className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
                  >
                    Domain Expiry
                    {sortBy === "expiry-asc" && <ArrowUp className="h-3 w-3" />}
                    {sortBy === "expiry-desc" && <ArrowDown className="h-3 w-3" />}
                    {sortBy !== "expiry-asc" && sortBy !== "expiry-desc" && (
                      <ChevronsUpDown className="h-3 w-3 opacity-40" />
                    )}
                  </button>
                </th>
                <th className="p-3 font-medium text-muted-foreground">Category</th>
                <th className="p-3 font-medium text-muted-foreground">Server</th>
                <th className="p-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredDomains.map((domain) => (
                <tr key={domain.id} className="hover:bg-muted/50">
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedDomains.includes(domain.id)}
                        onChange={() => toggleSelectDomain(domain.id)}
                        className="mr-2 h-4 w-4"
                      />
                      <a 
                        href={domain.uptime_url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                      >
                        {domain.display_name || domain.domain_name}
                        <ExternalLink size={12} />
                      </a>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">{domain.domain_name}</div>
                  </td>
                  <td className="p-3">
                    {!domain.uptime ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                        <span className="status-indicator status-unknown"></span>
                        Unknown
                      </span>
                    ) : domain.uptime.status ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        <span className="status-indicator status-up"></span>
                        Operational
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                        <span className="status-indicator status-down"></span>
                        Down
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    {!domain.ssl ? (
                      <span className="text-muted-foreground">Unknown</span>
                    ) : domain.ssl.days_remaining < 0 ? (
                      <span className="text-red-600 font-medium">Expired {Math.abs(domain.ssl.days_remaining)} days ago</span>
                    ) : domain.ssl.days_remaining <= 7 ? (
                      <span className="text-red-600 font-medium">{domain.ssl.days_remaining} days</span>
                    ) : domain.ssl.days_remaining <= 15 ? (
                      <span className="text-amber-600 font-medium">{domain.ssl.days_remaining} days</span>
                    ) : (
                      <span className="text-green-600">{domain.ssl.days_remaining} days</span>
                    )}
                  </td>
                  <td className="p-3">
                    {!domain.domain_expiry ? (
                      <span className="text-muted-foreground">Unknown</span>
                    ) : domain.domain_expiry.days_remaining < 0 ? (
                      <span className="text-red-600 font-medium">Expired {Math.abs(domain.domain_expiry.days_remaining)} days ago</span>
                    ) : domain.domain_expiry.days_remaining <= 7 ? (
                      <span className="text-red-600 font-medium">{domain.domain_expiry.days_remaining} days</span>
                    ) : domain.domain_expiry.days_remaining <= 30 ? (
                      <span className="text-amber-600 font-medium">{domain.domain_expiry.days_remaining} days</span>
                    ) : (
                      <span className="text-green-600">{domain.domain_expiry.days_remaining} days</span>
                    )}
                  </td>
                  <td className="p-3">
                    {domain.category ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium  text-blue-800  dark:text-blue-300">
                        {domain.category}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">Not set</span>
                    )}
                  </td>
                  <td className="p-3">
                    {!domain.ip_records ? (
                      <span className="text-muted-foreground">Unknown</span>
                    ) : (
                      <div className="group relative">
                        <span className="font-mono text-xs">{domain.ip_records.primary_ip}</span>
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
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end items-center gap-2">
                      <button
                        onClick={() => checkDomain(domain.id, domain.uptime_url, domain.domain_name)}
                        disabled={checkingDomain === domain.id}
                        className="btn btn-secondary flex items-center gap-2 py-1.5 px-3 text-xs"
                        title="Check all statuses for this domain"
                      >
                        {checkingDomain === domain.id ? (
                          <>
                            <RefreshCw size={14} className="animate-spin" />
                            <span className="hidden sm:inline">Checking...</span>
                          </>
                        ) : (
                          <>
                            <RefreshCw size={14} />
                            <span className="hidden sm:inline">Check Status</span>
                          </>
                        )}
                      </button>
                      <DomainActions domain={domain} onDelete={deleteDomain} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Monitoring Settings */}
      <div className="card mb-8">
        <div className="card-header">
          <h2 className="card-title">Monitoring Settings</h2>
          <p className="card-description">Configure how frequently automatic checks should run</p>
        </div>
        
        <div className="flex flex-col sm:flex-row gap-4 mt-4">
          <div className="flex-1">
            <label htmlFor="check_interval" className="block text-sm font-medium text-foreground mb-2">
              Automatic Check Interval
            </label>
            <div className="flex items-center relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Clock className="h-4 w-4 text-muted-foreground" />
              </div>
              <select
                id="check_interval"
                value={checkInterval}
                onChange={(e) => setCheckInterval(e.target.value)}
                className="block w-full pl-10 py-2 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
          </div>
          
          <div className="flex items-end">
            <button
              onClick={saveCheckInterval}
              className="btn-brand"
            >
              Save Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
} 