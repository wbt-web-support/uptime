import { CheckCircle, XCircle, ShieldAlert, AlertTriangle, Clock, Server, Globe } from 'lucide-react';

interface StatsOverviewProps {
  domains: Array<{
    uptime?: { status: boolean };
    ssl?: { days_remaining: number };
    domain_expiry?: { days_remaining: number };
    ip_records?: { primary_ip: string };
    category?: string;
  }>;
}

export default function StatsOverview({ domains }: StatsOverviewProps) {
  // Total domains count
  const totalDomains = domains.length;
  
  // Uptime stats
  const upDomains = domains.filter(d => d.uptime?.status === true).length;
  const downDomains = domains.filter(d => d.uptime?.status === false && d.category !== "Migration Done").length;
  const unknownStatusDomains = domains.length - upDomains - downDomains;
  
  // SSL stats
  const sslExpiringDomains = domains.filter(d => d.ssl?.days_remaining !== undefined && d.ssl.days_remaining <= 15).length;
  
  // Domain expiry stats
  const domainExpiringDomains = domains.filter(d => d.domain_expiry?.days_remaining !== undefined && d.domain_expiry.days_remaining <= 30).length;
  
  // IP stats
  const domainsWithIp = domains.filter(d => d.ip_records?.primary_ip).length;
  const domainsWithoutIp = domains.length - domainsWithIp;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      {/* Total Websites */}
      <div className="card">
        <h3 className="text-sm font-medium text-muted-foreground mb-2">Total Websites</h3>
        <div className="flex items-center gap-2">
          <div className="h-10 w-10 bg-purple-100 dark:bg-purple-950/50 rounded-full flex items-center justify-center">
            <Globe className="h-5 w-5 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Websites Monitored</p>
            <p className="text-xl font-bold">{totalDomains}</p>
          </div>
        </div>
      </div>
      
      {/* Uptime Status */}
      <div className="card">
        <h3 className="text-sm font-medium text-muted-foreground mb-2">Uptime Status</h3>
        <div className="flex gap-3">
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 bg-brand/10 rounded-full flex items-center justify-center">
              <CheckCircle className="h-5 w-5 text-brand" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Operational</p>
              <p className="text-xl font-bold">{upDomains}</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 bg-red-100 dark:bg-red-950/50 rounded-full flex items-center justify-center">
              <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Down</p>
              <p className="text-xl font-bold">{downDomains}</p>
            </div>
          </div>
        </div>
      </div>
      
      {/* SSL Status */}
      <div className="card">
        <h3 className="text-sm font-medium text-muted-foreground mb-2">SSL Certificates</h3>
        <div className="flex items-center gap-2">
          {sslExpiringDomains > 0 ? (
            <div className="h-10 w-10 bg-amber-100 dark:bg-amber-950/50 rounded-full flex items-center justify-center">
              <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
          ) : (
            <div className="h-10 w-10 bg-brand/10 rounded-full flex items-center justify-center">
              <ShieldAlert className="h-5 w-5 text-brand" />
            </div>
          )}
          <div>
            <p className="text-sm text-muted-foreground">Expiring soon / Expired</p>
            <p className="text-xl font-bold">{sslExpiringDomains}</p>
          </div>
        </div>
      </div>
      
      {/* Domain Expiry */}
      <div className="card">
        <h3 className="text-sm font-medium text-muted-foreground mb-2">Domain Registrations</h3>
        <div className="flex items-center gap-2">
          {domainExpiringDomains > 0 ? (
            <div className="h-10 w-10 bg-amber-100 dark:bg-amber-950/50 rounded-full flex items-center justify-center">
              <Clock className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
          ) : (
            <div className="h-10 w-10 bg-brand/10 rounded-full flex items-center justify-center">
              <Clock className="h-5 w-5 text-brand" />
            </div>
          )}
          <div>
            <p className="text-sm text-muted-foreground">Expiring soon</p>
            <p className="text-xl font-bold">{domainExpiringDomains}</p>
          </div>
        </div>
      </div>
      
      {/* IP Records */}
      <div className="card">
        <h3 className="text-sm font-medium text-muted-foreground mb-2">IP Records</h3>
        <div className="flex items-center gap-2">
          {domainsWithoutIp > 0 ? (
            <div className="h-10 w-10 bg-amber-100 dark:bg-amber-950/50 rounded-full flex items-center justify-center">
              <Server className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
          ) : (
            <div className="h-10 w-10 bg-brand/10 rounded-full flex items-center justify-center">
              <Server className="h-5 w-5 text-brand" />
            </div>
          )}
          <div>
            <p className="text-sm text-muted-foreground">With IP Records</p>
            <p className="text-xl font-bold">{domainsWithIp} / {domains.length}</p>
          </div>
        </div>
      </div>
    </div>
  );
} 