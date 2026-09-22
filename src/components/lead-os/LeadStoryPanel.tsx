// The full story of one customer: where they started, every captured chat row,
// the labels seen on screen, the current conversation state, the SLA clock,
// the next step and exactly how to approach it.
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BookOpen, Camera, Clock3, Copy, MessageSquare, Sparkles, Timer } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LeadJourneyStrip, FALLBACK_STEPS } from "./LeadJourneyStrip";
import {
  listJourneyProgress,
  listJourneySteps,
  listLibraryBuckets,
  listLibraryRows,
  type JourneyProgress,
  type JourneyStep,
  type LibraryBucket,
  type LibraryRow,
} from "@/lib/lead-os/library";
import { buildApproach, computeSla, humanAge, screenshotHeartbeat } from "@/lib/lead-os/sla";
import { QUICK_PRESETS, type QuickPreset } from "@/lib/pipeline/dossier-presets";
import { usePipeline } from "@/lib/pipeline/store";
import { useApp } from "@/lib/store";
import { useMovement } from "@/movement/store";
import { canonicalCustomerId } from "@/lib/canonical/customer-id";
import { useIdentityStore } from "@/lib/lead-identity/store";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  ok: "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warn: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  danger: "border-red-500/60 bg-red-500/10 text-red-600",
  muted: "border-border text-muted-foreground",
};

const pretty = (v?: string | null) => (v || "—").replaceAll("_", " ");

export function LeadStoryPanel({
  leadId,
  name,
  stepIndex,
  bucketCode,
  owned,
  closed,
  lastActivityAt,
}: {
  leadId: string;
  name?: string | null;
  stepIndex?: number | null;
  bucketCode?: string | null;
  owned?: boolean;
  closed?: boolean;
  lastActivityAt?: string | null;
}) {
  const [steps, setSteps] = useState<JourneyStep[]>(FALLBACK_STEPS);
  const [progress, setProgress] = useState<JourneyProgress[]>([]);
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [buckets, setBuckets] = useState<LibraryBucket[]>([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [allSteps, prog, libRows, libBuckets] = await Promise.all([
          listJourneySteps(),
          listJourneyProgress(leadId),
          listLibraryRows({ leadId, limit: 200 }),
          listLibraryBuckets(),
        ]);
        if (cancelled) return;
        if (allSteps.length) setSteps(allSteps);
        setProgress(prog);
        setRows(libRows);
        setBuckets(libBuckets);
      } catch {
        /* evidence is optional and never blocks the workspace */
      }
    })();
    return () => { cancelled = true; };
  }, [leadId]);

  // Oldest → newest so the operator reads the story from the start.
  const ordered = useMemo(
    () => [...rows].sort((a, b) => String(a.capture_date || "").localeCompare(String(b.capture_date || ""))),
    [rows],
  );
  const latest = ordered[ordered.length - 1] ?? null;
  const activeBucketCode = bucketCode || latest?.bucket || null;
  const bucket = useMemo(
    () => buckets.find((b) => b.bucket === activeBucketCode) ?? null,
    [buckets, activeBucketCode],
  );

  const current = progress.find((p) => p.status === "current");
  const currentIndex = current
    ? (steps.find((s) => s.code === current.step_code)?.ordinal ?? stepIndex ?? 1)
    : (stepIndex ?? 1);
  const currentStep = steps.find((s) => s.ordinal === currentIndex);
  const nextStep = steps.find((s) => s.ordinal === currentIndex + 1);

  const activity = lastActivityAt || latest?.capture_date || null;
  const sla = computeSla({ lastActivityAt: activity, bucket, owned: Boolean(owned), closed });
  const heartbeat = screenshotHeartbeat(activity, closed);
  const approach = buildApproach({
    name,
    bucket,
    lastMessage: latest?.last_message,
    direction: latest?.direction,
    draftDetected: ordered.some((r) => String((r as { draft_detected?: unknown }).draft_detected) === "true"),
  });

  const labels = Array.from(
    new Set(ordered.flatMap((r) => String(r.labels_ocr || "").split(/[,|]/).map((s) => s.trim()).filter(Boolean))),
  );

  const visible = showAll ? ordered : ordered.slice(-12);

  // ── One-Tap Qualification Presets ──────────────────────────────────────────
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const user = useIdentityStore((s) => s.currentUser);

  async function handlePresetClick(
    e: React.MouseEvent<HTMLButtonElement>,
    preset: QuickPreset,
  ) {
    e.preventDefault();
    setActivePresetId(preset.id);
    console.log("Preset clicked:", preset.id, preset.label);

    // 1. Update pipeline dossier
    usePipeline.getState().applyDossierPreset(leadId, preset.patch, {
      userId: user.id,
      userName: user.name,
    });

    // 2. Sync to CRM lead in useApp
    const app = useApp.getState();
    const crmLead = app.leads.find((l) => l.id === leadId);
    if (crmLead) {
      app.patchLead(leadId, {
        moveInDate: preset.patch.moveDate ?? crmLead.moveInDate,
        budget: preset.patch.budget ?? crmLead.budget,
        preferredArea: preset.patch.area ?? crmLead.preferredArea,
      });
      if (preset.patch.signals) {
        preset.patch.signals.forEach((sig) => app.addLeadTag(leadId, sig));
      }
    }

    // 3. Sync to Movement OS
    const mv = useMovement.getState();
    const cid = crmLead ? canonicalCustomerId({ phone: crmLead.phone, name: crmLead.name }) : leadId;
    const mvLead = Object.values(mv.states).find((s) => s.canonicalId === cid || s.canonicalId === leadId || s.ulid === leadId);
    if (mvLead) {
      mv.capture(mvLead.ulid, {
        moveInDate: preset.patch.moveDate ?? undefined,
        budget: preset.patch.budget ?? undefined,
        location: preset.patch.area ?? undefined,
      });
      mv.log(mvLead.ulid, "note", `Applied One-Tap Preset: ${preset.label}`);
    }

    // 4. Persist to hosted backend (e2e_lead_execution + e2e_lead_timeline)
    try {
      const { saveExecutionState, appendTimeline } = await import("@/e2eplus/persistence");
      await saveExecutionState({
        leadId,
        situation: "QUALIFYING",
        where: "CRM Lead Exists",
        verified: { moveDate: true, budget: true },
        timeline: [],
      });
      await appendTimeline(leadId, user.name || "Operator", `Applied One-Tap Preset: ${preset.label}`);
    } catch (err) {
      console.warn("Hosted backend sync for preset:", err);
    }

    // 5. Pre-format customer WhatsApp message & copy to clipboard
    const customerName = name || crmLead?.name || "there";
    const moveInText = preset.patch.moveDate ? `\n• Move-in: ${preset.patch.moveDate}` : "";
    const personaText = preset.patch.leadPersona ? `\n• Type: ${preset.patch.leadPersona}` : "";
    const msg = `Hi ${customerName}, confirming your qualification:\n• Requirement: ${preset.label}${personaText}${moveInText}\n\nWe are sharing tailored options for you shortly! 🏠`;

    try {
      await navigator.clipboard.writeText(msg);
      toast.success(`Preset "${preset.label}" applied & WhatsApp update copied!`);
    } catch (err) {
      console.error("Clipboard write failed:", err);
      toast.success(`Preset "${preset.label}" applied!`);
    }
  }

  return (
    <div className="space-y-3">
      {/* ── 1-Click Qualification Preset Bar ─────────────────────────── */}
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
          <Sparkles className="h-4 w-4 text-amber-600" />
          <span>⚡ One-Tap Presets (1-Click Qualify & Copy):</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {QUICK_PRESETS.slice(0, 8).map((preset) => {
            const isSelected = activePresetId === preset.id;
            return (
              <Button
                key={preset.id}
                type="button"
                size="sm"
                variant={isSelected ? "default" : "outline"}
                className={cn(
                  "h-7 text-xs transition cursor-pointer gap-1",
                  isSelected
                    ? "bg-amber-600 text-white font-bold border-amber-600 shadow-sm"
                    : "border-amber-500/50 hover:bg-amber-500/10 hover:text-amber-800 dark:hover:text-amber-300"
                )}
                onClick={(e) => { void handlePresetClick(e, preset); }}
              >
                <span>{preset.emoji}</span>
                <span>{preset.label}</span>
                {isSelected && <span className="ml-0.5 font-bold">✓</span>}
              </Button>
            );
          })}
        </div>
      </div>
      {/* ────────────────────────────────────────────────────────────── */}

      <Card className={`space-y-3 border-2 p-4 ${sla.tone === "danger" ? "border-red-500/60" : sla.tone === "warn" ? "border-amber-500/50" : "border-border"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-semibold"><Sparkles className="h-4 w-4" />Pick up from here</h2>
            <p className="text-xs text-muted-foreground">Start of the conversation → last message → labels → next step → how to approach.</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className={TONE[sla.tone]}><Timer className="mr-1 h-3 w-3" />{sla.label}</Badge>
            <Badge variant="outline"><Camera className="mr-1 h-3 w-3" />{heartbeat.label}</Badge>
            <Button asChild variant="outline" size="sm"><Link to="/conversation-library" search={{ bucket: undefined }}><BookOpen className="mr-1.5 h-3.5 w-3.5" />Library</Link></Button>
          </div>
        </div>

        <LeadJourneyStrip steps={steps} currentIndex={currentIndex} />

        <div className="grid gap-3 lg:grid-cols-3">
          <div className="rounded-lg border p-3 text-xs">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Conversation state</div>
            <div className="mt-1 font-semibold">{pretty(activeBucketCode) || "Unclassified"}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {bucket?.family && <Badge variant="secondary" className="text-[10px]">{bucket.family}</Badge>}
              {bucket?.waiting_on && <Badge variant="outline" className="text-[10px]">Waiting on {pretty(bucket.waiting_on)}</Badge>}
              {bucket?.priority && <Badge variant="outline" className="text-[10px]">{bucket.priority}</Badge>}
              {bucket?.stage && <Badge variant="outline" className="text-[10px]">{pretty(bucket.stage)}</Badge>}
            </div>
            {bucket?.rule_reason && <div className="mt-2 text-muted-foreground">{bucket.rule_reason}</div>}
          </div>

          <div className="rounded-lg border p-3 text-xs">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Now on step</div>
            <div className="mt-1 font-semibold">{currentStep ? `${currentStep.code} · ${currentStep.name}` : "S1 · Captured"}</div>
            {currentStep?.done_when && <div className="mt-1 text-muted-foreground">Done when: {currentStep.done_when}</div>}
            <div className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">Next step</div>
            <div className="mt-0.5 font-medium">{nextStep ? `${nextStep.code} · ${nextStep.name}` : "Journey complete"}</div>
            <div className="mt-1 text-muted-foreground">Next action: {pretty(bucket?.default_next_action)}{bucket?.sla_min ? ` · within ${humanAge(bucket.sla_min)}` : ""}</div>
          </div>

          <div className="rounded-lg border p-3 text-xs">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Last message seen</div>
            <div className="mt-1">{latest?.last_message || "No readable message captured yet"}</div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {latest ? `${latest.capture_date || "—"} · ${latest.visible_time || "—"} · ${pretty(latest.direction)} · OCR ${latest.ocr_confidence ?? "—"}%` : "—"}
            </div>
            <div className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">WhatsApp labels seen</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {labels.length ? labels.map((l) => <Badge key={l} variant="secondary" className="text-[10px]">{l}</Badge>) : <span className="text-muted-foreground">None on screen</span>}
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/30 p-3 text-xs">
          <div className="font-semibold">How to approach next — {approach.headline}</div>
          <div className="mt-1 text-muted-foreground">{approach.why}</div>
          <ol className="mt-2 list-decimal space-y-0.5 pl-4">
            {approach.moves.map((m) => <li key={m}>{m}</li>)}
          </ol>
          {approach.message && (
            <div className="mt-2 flex items-start gap-2 rounded border bg-background p-2">
              <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1">{approach.message}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  navigator.clipboard.writeText(approach.message).then(
                    () => toast.success("Message copied"),
                    () => toast.error("Could not copy — please copy manually."),
                  );
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {approach.guardrail && <div className="mt-2 rounded border border-amber-500/50 bg-amber-500/10 p-2 text-amber-700 dark:text-amber-400">{approach.guardrail}</div>}
        </div>
      </Card>

      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Clock3 className="h-4 w-4" />Every captured chat row, start to now</h3>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{ordered.length} rows</Badge>
            {ordered.length > 12 && (
              <Button size="sm" variant="outline" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show last 12" : "Show all"}</Button>
            )}
          </div>
        </div>
        {visible.map((row, index) => (
          <div key={row.row_id} className="rounded-lg border p-2 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="text-[10px]">#{ordered.indexOf(row) + 1}</Badge>
              {row.bucket && (
                <Link to="/conversation-library" search={{ bucket: row.bucket } as never}>
                  <Badge variant="secondary" className="text-[10px]">{pretty(row.bucket)}</Badge>
                </Link>
              )}
              {row.direction && <Badge variant="outline" className="text-[10px]">{pretty(row.direction)}</Badge>}
              {row.waiting_on && <Badge variant="outline" className="text-[10px]">waiting {pretty(row.waiting_on)}</Badge>}
              {row.priority && <Badge variant="outline" className="text-[10px]">{row.priority}</Badge>}
              {row.confidence_band && <Badge variant="outline" className="text-[10px]">{row.confidence_band}</Badge>}
              <span className="text-[10px] text-muted-foreground">{row.capture_date} · {row.visible_time || "—"} · {row.zone || "—"} · {row.screenshot}</span>
            </div>
            <div className="mt-1">{row.last_message || "No readable text on this row"}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {row.labels_ocr ? `Labels: ${row.labels_ocr} · ` : ""}
              {row.identity_status ? `${pretty(row.identity_status)} · ` : ""}
              {row.next_action ? `Next: ${pretty(row.next_action)}` : "No rule action"}
              {index === visible.length - 1 ? " · latest evidence" : ""}
            </div>
          </div>
        ))}
        {!ordered.length && <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">No screenshot evidence linked to this customer yet.</div>}
      </Card>
    </div>
  );
}
