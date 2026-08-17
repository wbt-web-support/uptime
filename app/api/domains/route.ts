import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { fetchLatestPerDomain } from "@/utils/latest-records";

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    
    // Check authentication
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get all domains
    const { data: domainsData, error: domainsError } = await supabase
      .from("domains")
      .select("*")
      .order("domain_name", { ascending: true });

    if (domainsError) throw domainsError;

    if (!domainsData || domainsData.length === 0) {
      return NextResponse.json({ domains: [] });
    }

    const domainIds = domainsData.map(domain => domain.id);

    // One row per domain, straight from the database. Asking for the whole history
    // table and keeping the newest row per domain looks equivalent but is not:
    // PostgREST caps a response at 1000 rows, and these tables hold tens of
    // thousands, so the older domains silently fell off the end and rendered as
    // "Unknown". See utils/latest-records.ts.
    const [uptimeMap, sslMap, expiryMap, ipMap] = await Promise.all([
      fetchLatestPerDomain(supabase, 'uptime_logs', domainIds),
      fetchLatestPerDomain(supabase, 'ssl_info', domainIds),
      fetchLatestPerDomain(supabase, 'domain_expiry', domainIds),
      fetchLatestPerDomain(supabase, 'ip_records', domainIds),
    ]);

    // Combine all data
    const domainsWithStatus = domainsData.map(domain => ({
      ...domain,
      uptime: uptimeMap.get(domain.id) || null,
      ssl: sslMap.get(domain.id) || null,
      domain_expiry: expiryMap.get(domain.id) || null,
      ip_records: ipMap.get(domain.id) || null
    }));

    return NextResponse.json({ domains: domainsWithStatus });
  } catch (error: any) {
    console.error("Error fetching domains:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

