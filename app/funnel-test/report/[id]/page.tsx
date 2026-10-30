"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { ArrowLeft, ExternalLink, Monitor, MousePointerClick, Smartphone } from "lucide-react";
import { FunnelReportView, type ReportMeta } from "@/components/FunnelReportView";

// Full report for one funnel test or UI check on one device, as saved in
// funnel_reports. The report itself is FunnelReportView, also shown in place on a
// website's report page; screenshots come from the funnel tester through
// /api/funnels/screenshot.
export default function FunnelReportPage() {
  const { id } = useParams<{ id: string }>();
  const supabase = useMemo(() => createClient(), []);
  const [meta, setMeta] = useState<ReportMeta | null>(null);
  const [funnel, setFunnel] = useState<{ name: string; url: string } | null>(null);

  const onLoaded = async (m: ReportMeta) => {
    setMeta(m);
    const { data: f } = await supabase.from("funnels").select("name, url").eq("id", m.funnel_id).maybeSingle();
    setFunnel(f);
  };

  const DeviceIcon = meta?.viewport === "mobile" ? Smartphone : Monitor;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <Link href="/funnel-test" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Funnel Test
      </Link>

      {meta && (
        <div className="mb-6">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold">
            {meta.kind === "ui" ? <MousePointerClick className="h-6 w-6" /> : <DeviceIcon className="h-6 w-6" />}
            {funnel?.name || "Funnel"}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            <span>{meta.kind === "ui" ? "UI check" : "Funnel test"}</span>
            <span>·</span>
            <span className="inline-flex items-center gap-1"><DeviceIcon className="h-3.5 w-3.5" />{meta.viewport === "mobile" ? "Mobile" : "Desktop"}</span>
            <span>·</span>
            <span>{new Date(meta.created_at).toLocaleString()}</span>
            {funnel?.url && (
              <a href={funnel.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                · {funnel.url} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </p>
        </div>
      )}

      <FunnelReportView id={id} onLoaded={onLoaded} />
    </div>
  );
}
