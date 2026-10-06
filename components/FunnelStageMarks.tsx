import { STAGES, type FunnelStages, type StageState } from "@/utils/funnel-report";

// The four stages of one funnel test in a row:
// ✓ Form → ✓ SMS → ✓ Thank-you → ✓ Save & Checkout
const STAGE_STYLE: Record<StageState, { mark: string; cls: string; note: string }> = {
  ok: { mark: "✓", cls: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-400", note: "worked" },
  failed: { mark: "✕", cls: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400", note: "failed" },
  none: { mark: "–", cls: "border-border text-muted-foreground", note: "not on this funnel" },
  pending: { mark: "·", cls: "border-dashed border-border text-muted-foreground/60", note: "not reached" },
  unknown: { mark: "?", cls: "border-border text-muted-foreground", note: "not recorded for this older test - run it again" },
};

export function FunnelStageMarks({ stages, label, full = false }: { stages: FunnelStages | null; label?: string; full?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {label && <span className="mr-1 w-36 truncate text-xs font-medium">{label}</span>}
      {stages ? (
        STAGES.map((s, i) => {
          const st = STAGE_STYLE[stages[s.key]];
          return (
            <span key={s.key} className="inline-flex items-center gap-1">
              {i > 0 && <span className="text-[10px] text-muted-foreground/50">→</span>}
              <span
                className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${full ? "text-xs" : "text-[11px]"} ${st.cls}`}
                title={`${s.label}: ${st.note}`}
              >
                {st.mark} {full ? s.label : s.short}
              </span>
            </span>
          );
        })
      ) : (
        <span className="text-[11px] text-muted-foreground">Not tested yet</span>
      )}
    </div>
  );
}
