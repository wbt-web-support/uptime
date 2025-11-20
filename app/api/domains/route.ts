import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

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

    // Fetch all records in parallel, but we'll process them server-side
    // This is more efficient than individual queries per domain
    const [uptimeResult, sslResult, expiryResult, ipResult] = await Promise.all([
      supabase
        .from('uptime_logs')
        .select('*')
        .in('domain_id', domainIds)
        .order('checked_at', { ascending: false }),
      supabase
        .from('ssl_info')
        .select('*')
        .in('domain_id', domainIds)
        .order('checked_at', { ascending: false }),
      supabase
        .from('domain_expiry')
        .select('*')
        .in('domain_id', domainIds)
        .order('checked_at', { ascending: false }),
      supabase
        .from('ip_records')
        .select('*')
        .in('domain_id', domainIds)
        .order('checked_at', { ascending: false })
    ]);

    if (uptimeResult.error) throw uptimeResult.error;
    if (sslResult.error) throw sslResult.error;
    if (expiryResult.error) throw expiryResult.error;
    if (ipResult.error) throw ipResult.error;

    // Process server-side to get only latest per domain (more efficient than client-side)
    const uptimeMap = new Map();
    if (uptimeResult.data) {
      uptimeResult.data.forEach((log: any) => {
        if (!uptimeMap.has(log.domain_id)) {
          uptimeMap.set(log.domain_id, log);
        }
      });
    }

    const sslMap = new Map();
    if (sslResult.data) {
      sslResult.data.forEach((ssl: any) => {
        if (!sslMap.has(ssl.domain_id)) {
          sslMap.set(ssl.domain_id, ssl);
        }
      });
    }

    const expiryMap = new Map();
    if (expiryResult.data) {
      expiryResult.data.forEach((exp: any) => {
        if (!expiryMap.has(exp.domain_id)) {
          expiryMap.set(exp.domain_id, exp);
        }
      });
    }

    const ipMap = new Map();
    if (ipResult.data) {
      ipResult.data.forEach((ip: any) => {
        if (!ipMap.has(ip.domain_id)) {
          ipMap.set(ip.domain_id, ip);
        }
      });
    }

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

