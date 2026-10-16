"use client";

import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/utils/supabase/client";
import { signOutAction } from "@/app/actions";
import StatusCard from "@/components/StatusCard";
import DomainForm from "@/components/DomainForm";
import DashboardHeader from "@/components/DashboardHeader";
import StatsOverview from "@/components/StatsOverview";
import DomainActions from "@/components/DomainActions";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Clock, CheckCircle, RefreshCw, Activity, Shield, Globe, Server, ExternalLink, Trash2, ArrowUp, ArrowDown, ChevronsUpDown, ChevronLeft, ChevronRight, X, Download, FileText, FileJson, FileType } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { exportRows, domainToExportRow, type ExportFormat } from "@/utils/export";

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
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "domain" | "status-asc" | "status-desc" | "ssl-asc" | "ssl-desc" | "expiry-asc" | "expiry-desc" | "category-asc" | "category-desc">("domain");
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [selectAll, setSelectAll] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>("none");
  const [checkResults, setCheckResults] = useState<{
    successes: number;
    failures: number;
    total: number;
  }>({ successes: 0, failures: 0, total: 0 });
  const [checkingDomain, setCheckingDomain] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);
  const [showAddForm, setShowAddForm] = useState(false);
  const supabase = createClient();

  const fetchDomains = async () => {
    setLoading(true);
    try {
      // Use optimized server-side API route
      const response = await fetch('/api/domains', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch domains');
      }

      const { domains: domainsWithStatus } = await response.json();
      setDomains(domainsWithStatus || []);
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

  // Function to get category color classes
  const getCategoryColor = (category: string) => {
    const colorMap: Record<string, string> = {
      "none": "bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400",
      "Live Website": "bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400",
      "Live Website Temporary Suspended": "bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400",
      "Migration Done": "bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400",
      "Migration Pending": "bg-orange-100 text-orange-800 dark:bg-orange-900/20 dark:text-orange-400",
      "Draft Website": "bg-slate-100 text-slate-800 dark:bg-slate-900/20 dark:text-slate-400",
      "Draft Suspended Website": "bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400"
    };

    return colorMap[category] || "bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400";
  };

  // Function to get short display name for category
  const getCategoryDisplayName = (category: string) => {
    const shortNames: Record<string, string> = {
      "none": "none",
      "Live Website": "Live",
      "Live Website Temporary Suspended": "Temp Suspended",
      "Migration Done": "Migration Done",
      "Migration Pending": "Migration Pending",
      "Draft Website": "Draft",
      "Draft Suspended Website": "Draft Suspended"
    };

    return shortNames[category] || category;
  };

  // Get all unique categories from domains
  const categories = ["all", ...Array.from(new Set(domains
    .filter(domain => domain.category)
    .map(domain => domain.category)
  ))];

  // Filter and sort domains with memoization for performance
  const filteredDomains = useMemo(() => {
    return domains.filter(domain => {
      const matchesSearch =
        domain.domain_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        searchQuery.toLowerCase().includes(domain.domain_name.toLowerCase()) ||
        (domain.display_name && domain.display_name.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (domain.uptime_url && domain.uptime_url.toLowerCase().includes(searchQuery.toLowerCase()));

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
      switch (sortBy) {
        case "newest":
          return new Date(b.uptime?.checked_at || 0).getTime() - new Date(a.uptime?.checked_at || 0).getTime();
        case "oldest":
          return new Date(a.uptime?.checked_at || 0).getTime() - new Date(b.uptime?.checked_at || 0).getTime();
        case "domain":
          return (a.display_name || a.domain_name).localeCompare(b.display_name || b.domain_name);
        case "status-asc":
          // Sort by status (up first, then down, then unknown)
          const aStatusAsc = a.uptime?.status;
          const bStatusAsc = b.uptime?.status;
          if (aStatusAsc === bStatusAsc) return 0;
          if (aStatusAsc === true) return -1;
          if (bStatusAsc === true) return 1;
          if (aStatusAsc === false) return -1;
          return 1;
        case "status-desc":
          // Sort by status (unknown first, then down, then up)
          const aStatusDesc = a.uptime?.status;
          const bStatusDesc = b.uptime?.status;
          if (aStatusDesc === bStatusDesc) return 0;
          if (aStatusDesc === undefined || aStatusDesc === null) return -1;
          if (bStatusDesc === undefined || bStatusDesc === null) return 1;
          if (aStatusDesc === false) return -1;
          if (bStatusDesc === false) return 1;
          return 1;
        case "category-asc":
          // Sort by category alphabetically (ascending)
          const aCategoryAsc = (a.category || "").toLowerCase();
          const bCategoryAsc = (b.category || "").toLowerCase();
          return aCategoryAsc.localeCompare(bCategoryAsc);
        case "category-desc":
          // Sort by category alphabetically (descending)
          const aCategoryDesc = (a.category || "").toLowerCase();
          const bCategoryDesc = (b.category || "").toLowerCase();
          return bCategoryDesc.localeCompare(aCategoryDesc);
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
  }, [domains, searchQuery, statusFilter, categoryFilter, sortBy]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredDomains.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedDomains = useMemo(() => {
    return filteredDomains.slice(startIndex, endIndex);
  }, [filteredDomains, startIndex, endIndex]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter, categoryFilter, sortBy]);

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

  const exportSelectedDomains = (format: ExportFormat) => {
    if (selectedDomains.length === 0) return;
    const selected = domains.filter(domain => selectedDomains.includes(domain.id));
    const rows = selected.map(domainToExportRow);
    const stamp = new Date().toISOString().slice(0, 10);
    exportRows(format, rows, `domains-export-${stamp}`, "Domain Monitoring Export");
    setSuccess(`Exported ${rows.length} ${rows.length === 1 ? 'domain' : 'domains'} as ${format.toUpperCase()}`);
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

      // Auto-unselect after update
      setSelectedDomains([]);
      setSelectAll(false);

      fetchDomains(); // Refresh data
    } catch (error: any) {
      setError(error.message);
      setLoading(false);
    } finally {
      setLoading(false);
    }
  };

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
    <div className="container mx-auto py-6 px-4">
      <DashboardHeader
        title="Admin Panel"
        description=" "
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        categoryFilter={categoryFilter}
        setCategoryFilter={setCategoryFilter}
        categories={categories}
        totalCount={domains.length}
        filteredCount={filteredDomains.length}
        isAdmin={true}
        onAddClick={() => setShowAddForm(!showAddForm)}
        stats={stats}
        categoryStats={categoryStats}
        sortBy={sortBy}
        setSortBy={setSortBy as any}
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

      <DomainForm
        isOpen={showAddForm}
        onOpenChange={setShowAddForm}
        onSave={() => {
          fetchDomains();
          setShowAddForm(false);
        }}
      />

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
                  <SelectItem value="none">none</SelectItem>
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
                disabled={loading || selectedCategory === "none"}
              >
                Update Category
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setSelectedDomains([]); setSelectAll(false); }}
                className="btn btn-secondary flex items-center gap-2"
                disabled={loading}
                title="Unselect all"
              >
                <X size={16} />
                Unselect
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="btn btn-secondary flex items-center gap-2" disabled={loading}>
                    <Download size={16} />
                    Export
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuLabel>Export {selectedDomains.length} selected</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => exportSelectedDomains("csv")} className="gap-2 cursor-pointer">
                    <FileText size={16} /> CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportSelectedDomains("pdf")} className="gap-2 cursor-pointer">
                    <FileType size={16} /> PDF
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportSelectedDomains("json")} className="gap-2 cursor-pointer">
                    <FileJson size={16} /> JSON
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
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
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  {[...Array(7)].map((_, i) => (
                    <th key={i} className="p-3"><Skeleton className="h-4 w-24" /></th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[...Array(10)].map((_, i) => (
                  <tr key={i}>
                    <td className="p-3">
                      <div className="flex gap-3 items-center">
                        <Skeleton className="h-4 w-4" />
                        <div className="space-y-2">
                          <Skeleton className="h-4 w-32" />
                          <Skeleton className="h-3 w-48" />
                        </div>
                      </div>
                    </td>
                    {[...Array(6)].map((_, j) => (
                      <td key={j} className="p-3"><Skeleton className="h-4 w-20" /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
        <div className="card overflow-hidden">
          <div className="overflow-x-auto max-h-[calc(100vh-100px)] overflow-y-auto">
            <table className="w-full">
              <thead className="text-left bg-muted sticky top-0 z-10">
                <tr>
                  <th className="p-3 font-medium text-muted-foreground bg-muted">
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
                  <th className="p-3 font-medium text-muted-foreground bg-muted">
                    <button
                      onClick={() => setSortBy(sortBy === "status-asc" ? "status-desc" : "status-asc")}
                      className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
                    >
                      Status
                      {sortBy === "status-asc" && <ArrowUp className="h-3 w-3" />}
                      {sortBy === "status-desc" && <ArrowDown className="h-3 w-3" />}
                      {sortBy !== "status-asc" && sortBy !== "status-desc" && (
                        <ChevronsUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </button>
                  </th>
                  <th className="p-3 font-medium text-muted-foreground bg-muted">
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
                  <th className="p-3 font-medium text-muted-foreground bg-muted">
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
                  <th className="p-3 font-medium text-muted-foreground bg-muted">
                    <button
                      onClick={() => setSortBy(sortBy === "category-asc" ? "category-desc" : "category-asc")}
                      className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
                    >
                      Category
                      {sortBy === "category-asc" && <ArrowUp className="h-3 w-3" />}
                      {sortBy === "category-desc" && <ArrowDown className="h-3 w-3" />}
                      {sortBy !== "category-asc" && sortBy !== "category-desc" && (
                        <ChevronsUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </button>
                  </th>
                  <th className="p-3 font-medium text-muted-foreground bg-muted">Server</th>
                  <th className="p-3 font-medium text-muted-foreground bg-muted">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {paginatedDomains.map((domain) => (
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
                        <span className={`inline-flex items-center px-2.5 text-nowrap py-0.5 rounded-full text-xs font-medium ${getCategoryColor(domain.category)}`} title={domain.category}>
                          {getCategoryDisplayName(domain.category)}
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
        </div>
      )}

      {/* Pagination Controls */}
      {filteredDomains.length > 0 && (
        <div className="border p-2 rounded-lg mt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">
              Showing {startIndex + 1} to {Math.min(endIndex, filteredDomains.length)} of {filteredDomains.length} domains
            </span>
            <div className="flex items-center gap-2">
              <label htmlFor="itemsPerPage" className="text-sm text-muted-foreground">
                Per page:
              </label>
              <Select
                value={itemsPerPage.toString()}
                onValueChange={(value) => {
                  setItemsPerPage(Number(value));
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger className="w-[80px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
              className="btn btn-secondary flex items-center gap-2 px-3 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronLeft size={16} />
              <span className="hidden sm:inline">Previous</span>
            </button>

            <div className="flex items-center gap-1">
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                let pageNum;
                if (totalPages <= 7) {
                  pageNum = i + 1;
                } else if (currentPage <= 4) {
                  pageNum = i + 1;
                } else if (currentPage >= totalPages - 3) {
                  pageNum = totalPages - 6 + i;
                } else {
                  pageNum = currentPage - 3 + i;
                }

                return (
                  <button
                    key={pageNum}
                    onClick={() => setCurrentPage(pageNum)}
                    className={`px-3 py-2 text-sm rounded-md transition-colors ${currentPage === pageNum
                      ? 'bg-brand text-white'
                      : 'bg-muted hover:bg-muted/80 text-foreground'
                      }`}
                  >
                    {pageNum}
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
              disabled={currentPage === totalPages}
              className="btn btn-secondary flex items-center gap-2 px-3 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="hidden sm:inline">Next</span>
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Monitoring Settings 
      <div className="card mb-8 mt-6">
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
      */}
    </div>
  );
} 