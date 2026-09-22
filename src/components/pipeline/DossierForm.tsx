import { useState } from "react";
import { usePipeline } from "@/lib/pipeline/store";
import {
  dossierFieldStatus,
  missingDossierFields,
} from "@/lib/pipeline/stage-engine";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useIdentityStore } from "@/lib/lead-identity/store";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CheckCircle2, Circle, MinusCircle, SkipForward, X, Zap } from "lucide-react";
import type { Dossier } from "@/lib/pipeline/types";
import {
  SIGNAL_PRESETS, CLOSING_EXPECTATIONS, GOAL_OPTIONS, LEAD_PERSONAS,
  DOSSIER_FIELD_LABELS, QUICK_PRESETS, WHY_MAP,
} from "@/lib/pipeline/dossier-presets";
import { WhyCaption, WhySectionBanner } from "@/components/common/WhyCaption";
import { LifecyclePanel } from "@/components/pipeline/LifecyclePanel";
import { toast } from "sonner";
import { useApp } from "@/lib/store";
import { useMovement } from "@/movement/store";
import { canonicalCustomerId } from "@/lib/canonical/customer-id";
import type { QuickPreset } from "@/lib/pipeline/dossier-presets";

interface Props { leadId: string; }

type FieldKey = keyof Dossier;

/**
 * Rich, live dossier form. Every field shows a status dot
 * (green filled · red empty · amber skipped), can be deferred with a reason,
 * and carries an always-visible "why this exists / who benefits" caption.
 */
export function DossierForm({ leadId }: Props) {
  const dossier = usePipeline((s) => s.states[leadId]?.dossier ?? { completionPct: 0 } as Dossier);
  const updateDossier = usePipeline((s) => s.updateDossier);
  const applyPreset = usePipeline((s) => s.applyDossierPreset);
  const advanceStage = usePipeline((s) => s.advanceStage);
  const user = useIdentityStore((s) => s.currentUser);
  const missing = missingDossierFields(dossier);

  const patch = (p: Partial<Dossier>) =>
    updateDossier(leadId, p, { userId: user.id, userName: user.name });

  const skip = (key: FieldKey, reason: string) => {
    const next = { ...(dossier.skipped ?? {}) };
    if (reason) next[key as string] = reason;
    else delete next[key as string];
    patch({ skipped: next });
  };

  const unskip = (key: FieldKey) => skip(key, "");

  const toggleSignal = (s: string) => {
    const cur = dossier.signals ?? [];
    patch({ signals: cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s] });
  };
  const [presetFilter, setPresetFilter] = useState("");
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const filteredPresets = QUICK_PRESETS.filter((p) =>
    !presetFilter || p.label.toLowerCase().includes(presetFilter.toLowerCase()),
  );

  /** True when clicked directly or when preset fields match the current dossier state. */
  const isPresetActive = (p: QuickPreset) => {
    if (activePresetId === p.id) return true;
    const patch = p.patch;
    const nonArrayKeys = (Object.keys(patch) as (keyof typeof dossier)[]).filter(
      (k) => k !== "signals" && !Array.isArray(patch[k])
    );
    const nonArraysMatch = nonArrayKeys.every((k) => dossier[k] === patch[k]);
    if (!nonArraysMatch) return false;
    if (patch.signals && patch.signals.length > 0) {
      const curSignals = dossier.signals ?? [];
      return patch.signals.every((s) => curSignals.includes(s));
    }
    return true;
  };

  const handleApplyPreset = async (p: QuickPreset) => {
    setActivePresetId(p.id);
    console.log("Applying preset:", p.id, p.label);

    // 1. Update pipeline dossier store
    applyPreset(leadId, p.patch, { userId: user.id, userName: user.name });

    // 2. Sync to CRM lead in useApp
    const app = useApp.getState();
    const crmLead = app.leads.find((l) => l.id === leadId);
    if (crmLead) {
      app.patchLead(leadId, {
        moveInDate: p.patch.moveDate ?? crmLead.moveInDate,
        budget: p.patch.budget ?? crmLead.budget,
        preferredArea: p.patch.area ?? crmLead.preferredArea,
      });
      if (p.patch.signals) {
        p.patch.signals.forEach((sig) => app.addLeadTag(leadId, sig));
      }
    }

    // 3. Sync to Movement OS
    const mv = useMovement.getState();
    const cid = crmLead ? canonicalCustomerId({ phone: crmLead.phone, name: crmLead.name }) : leadId;
    const mvLead = Object.values(mv.states).find((s) => s.canonicalId === cid || s.canonicalId === leadId || s.ulid === leadId);
    if (mvLead) {
      mv.capture(mvLead.ulid, {
        moveInDate: p.patch.moveDate ?? undefined,
        budget: p.patch.budget ?? undefined,
        location: p.patch.area ?? undefined,
      });
      mv.log(mvLead.ulid, "note", `Applied One-Tap Preset: ${p.label}`);
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
      await appendTimeline(leadId, user.name || "Operator", `Applied One-Tap Preset: ${p.label}`);
    } catch (err) {
      console.warn("Hosted backend sync for preset:", err);
    }

    // 5. Pre-format customer WhatsApp confirmation message
    const customerName = crmLead?.name ?? mvLead?.name ?? "there";
    const moveInText = p.patch.moveDate ? `\n• Move-in: ${p.patch.moveDate}` : "";
    const personaText = p.patch.leadPersona ? `\n• Type: ${p.patch.leadPersona}` : "";
    const msg = `Hi ${customerName}, confirming your qualification:\n• Requirement: ${p.label}${personaText}${moveInText}\n\nWe are sharing tailored options for you shortly! 🏠`;

    try {
      await navigator.clipboard.writeText(msg);
      toast.success(`Preset "${p.label}" applied & WhatsApp update copied!`);
    } catch {
      toast.success(`Preset "${p.label}" applied!`);
    }
  };

  return (
    <div className="space-y-4">
      {/* Quick-fill preset chips — one tap stamps 3-5 fields at once */}
      <div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-2.5 space-y-1.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-primary font-semibold">
          <Zap className="h-3 w-3" /> One-tap presets
          <span className="text-muted-foreground/70 normal-case font-normal">· merges with what you’ve filled</span>
          <Input
            className="h-6 ml-auto w-32 text-[11px]"
            placeholder="Filter presets…"
            value={presetFilter}
            onChange={(e) => setPresetFilter(e.target.value)}
          />
        </div>
        <WhyCaption
          compact
          why="Presets stamp 3-5 fields at once so filling stays under 30 seconds."
          admin="Standardises how leads are tagged across the whole team."
          tcm="Zero typing when a lead matches a common pattern."
          client="Faster first response — right script from message #1."
        />
        <div className="flex flex-wrap gap-1">
          {filteredPresets.map((p) => {
            const active = isPresetActive(p);
            return (
              <button
                key={p.id}
                type="button"
                title={p.hint}
                onClick={() => { void handleApplyPreset(p); }}
                className={cn(
                  "text-[11px] px-2.5 py-1 rounded-md border transition inline-flex items-center gap-1 cursor-pointer",
                  active
                    ? "border-primary bg-primary/20 text-primary font-bold shadow-sm ring-1 ring-primary/40"
                    : "border-border bg-background text-foreground hover:bg-primary/10 hover:border-primary/40",
                )}
              >
                <span>{p.emoji}</span>{p.label}
                {active && <span className="text-[10px] ml-1 font-bold text-primary">✓</span>}
              </button>
            );
          })}

          {filteredPresets.length === 0 && (
            <span className="text-[10px] text-muted-foreground">No preset matches "{presetFilter}"</span>
          )}
        </div>
      </div>

      {/* Deal read — the "can we even close this?" section, up top */}
      <Section
        title="Deal read"
        subtitle="Set this before you call. If it's 'try nearby' — reassign."
        banner={{
          why: "Frames the whole conversation before the first call.",
          admin: "Downstream forecast + reassignment triggers.",
          tcm: "Right script, right effort, right stage cadence.",
          client: "They aren't over-pressured for a bad fit.",
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <FieldRow
            k="closingExpectation" dossier={dossier}
            onSkip={(r) => skip("closingExpectation", r)} onUnskip={() => unskip("closingExpectation")}
          >
            <div className="grid grid-cols-2 gap-1.5">
              {CLOSING_EXPECTATIONS.map((o) => {
                const active = dossier.closingExpectation === o.key;
                return (
                  <button key={o.key}
                    type="button"
                    onClick={() => patch({ closingExpectation: o.key })}
                    className={cn(
                      "text-[11px] px-2 py-1.5 rounded-md border transition",
                      active ? o.tone : "bg-background text-muted-foreground border-border hover:bg-muted",
                    )}>
                    {o.label}
                  </button>
                );
              })}
            </div>
          </FieldRow>

          <FieldRow
            k="goal" dossier={dossier}
            onSkip={(r) => skip("goal", r)} onUnskip={() => unskip("goal")}
          >
            <div className="flex gap-1.5">
              {GOAL_OPTIONS.map((o) => {
                const active = dossier.goal === o.key;
                return (
                  <button key={o.key} type="button"
                    onClick={() => patch({ goal: o.key })}
                    className={cn(
                      "flex-1 text-[11px] px-2 py-1.5 rounded-md border transition",
                      active
                        ? "border-accent bg-accent/10 text-accent"
                        : "bg-background text-muted-foreground border-border hover:bg-muted",
                    )}>
                    {o.label}
                  </button>
                );
              })}
            </div>
          </FieldRow>
        </div>
      </Section>

      {/* Who is coming — persona */}
      <Section
        title="Who is coming"
        subtitle="Solo? Couple? Group of 10 interns? Pitch shifts either way."
        banner={{
          why: "Persona changes room math, price, and pitch on line one.",
          admin: "Rolls up team's persona mix + demand.",
          tcm: "Auto-picks matching properties + tier.",
          client: "Fewer wrong options, faster yes.",
        }}
      >
        <FieldRow
          k="leadPersona" dossier={dossier} inline
          onSkip={(r) => skip("leadPersona", r)} onUnskip={() => unskip("leadPersona")}
        >
          <div className="flex flex-wrap gap-1.5">
            {LEAD_PERSONAS.map((p) => {
              const active = dossier.leadPersona === p.key;
              return (
                <button key={p.key} type="button"
                  onClick={() => patch({ leadPersona: p.key })}
                  className={cn(
                    "text-[11px] px-2 py-1 rounded-full border transition inline-flex items-center gap-1",
                    active
                      ? "border-accent bg-accent/10 text-accent"
                      : "bg-background text-muted-foreground border-border hover:bg-muted",
                  )}>
                  <span>{p.emoji}</span>{p.label}
                  <span className="text-[9px] px-1 rounded bg-muted-foreground/10 font-mono">{p.code}</span>
                </button>
              );
            })}
            {(dossier.leadPersona?.startsWith("group") || dossier.leadPersona === "family") && (
              <div className="inline-flex items-center gap-1 ml-2">
                <span className="text-[10px] text-muted-foreground">Size</span>
                <Input
                  type="number" min={2}
                  className="h-7 w-16 text-xs"
                  value={dossier.groupSize ?? ""}
                  onChange={(e) => patch({ groupSize: Number(e.target.value) || undefined })}
                />
              </div>
            )}
          </div>
        </FieldRow>
      </Section>

      {/* Signals chip strip */}
      <Section
        title="Notes & signals"
        subtitle="Tap to mark. These flow to the header for scan-at-a-glance."
        banner={{
          why: "One-tap tags become the header chips + queue filters.",
          admin: "Signal mix per TCM + zone becomes a report.",
          tcm: "No prose needed — one tap = a real flag.",
          client: "Their real preferences travel with the lead.",
        }}
      >
        <div className="flex flex-wrap gap-1.5">
          {SIGNAL_PRESETS.map((s) => {
            const active = (dossier.signals ?? []).includes(s.key);
            const toneOn =
              s.tone === "hot"  ? "border-destructive/50 bg-destructive/10 text-destructive"
            : s.tone === "warn" ? "border-warning/50 bg-warning/10 text-warning"
            :                     "border-muted-foreground/30 bg-muted text-muted-foreground";
            return (
              <button key={s.key} type="button" onClick={() => toggleSignal(s.key)}
                className={cn(
                  "text-[11px] px-2 py-1 rounded-full border transition inline-flex items-center gap-1",
                  active ? toneOn : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}>
                {active && <span className="text-[10px]">✓</span>}
                {s.label}
              </button>
            );
          })}
        </div>
      </Section>

      {/* Feasibility grid */}
      <Section
        title="Feasibility"
        banner={{
          why: "Hard filters — budget/date/gender kill the match if wrong.",
          admin: "Feeds occupancy + budget-loss dashboards.",
          tcm: "No wasted tours to over-budget / wrong-gender stock.",
          client: "No sticker-shock, no wrong-property visit.",
        }}
      >
        <div className="grid grid-cols-3 gap-3">
          <FieldRow k="moveDate" dossier={dossier}
            onSkip={(r) => skip("moveDate", r)} onUnskip={() => unskip("moveDate")}>
            <Input type="date" value={dossier.moveDate ?? ""}
              onChange={(e) => patch({ moveDate: e.target.value })} />
          </FieldRow>
          <FieldRow k="budget" dossier={dossier}
            onSkip={(r) => skip("budget", r)} onUnskip={() => unskip("budget")}>
            <Input type="number" placeholder="₹" value={dossier.budget ?? ""}
              onChange={(e) => patch({ budget: Number(e.target.value) })} />
          </FieldRow>
          <FieldRow k="area" dossier={dossier}
            onSkip={(r) => skip("area", r)} onUnskip={() => unskip("area")}>
            <Input value={dossier.area ?? ""}
              onChange={(e) => patch({ area: e.target.value })} />
          </FieldRow>

          <FieldRow k="gender" dossier={dossier}
            onSkip={(r) => skip("gender", r)} onUnskip={() => unskip("gender")}>
            <Select value={dossier.gender ?? ""} onValueChange={(v) => patch({ gender: v as Dossier["gender"] })}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="male">Male</SelectItem>
                <SelectItem value="female">Female</SelectItem>
                <SelectItem value="coed">Coed</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow k="sharing" dossier={dossier}
            onSkip={(r) => skip("sharing", r)} onUnskip={() => unskip("sharing")}>
            <Select value={dossier.sharing ?? ""} onValueChange={(v) => patch({ sharing: v as Dossier["sharing"] })}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private</SelectItem>
                <SelectItem value="double">Double</SelectItem>
                <SelectItem value="triple">Triple</SelectItem>
                <SelectItem value="any">Any</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow k="movingFeasibility" dossier={dossier}
            onSkip={(r) => skip("movingFeasibility", r)} onUnskip={() => unskip("movingFeasibility")}>
            <Select value={dossier.movingFeasibility ?? ""} onValueChange={(v) => patch({ movingFeasibility: v as Dossier["movingFeasibility"] })}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="immediate">Immediate</SelectItem>
                <SelectItem value="7d">Within 7 days</SelectItem>
                <SelectItem value="15d">Within 15 days</SelectItem>
                <SelectItem value="30d">Within 30 days</SelectItem>
                <SelectItem value="researching">Just researching</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          <FieldRow k="decisionMaker" dossier={dossier}
            onSkip={(r) => skip("decisionMaker", r)} onUnskip={() => unskip("decisionMaker")}>
            <Select value={dossier.decisionMaker ?? ""} onValueChange={(v) => patch({ decisionMaker: v as Dossier["decisionMaker"] })}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="self">Self</SelectItem>
                <SelectItem value="parents">Parents</SelectItem>
                <SelectItem value="friends">Friends</SelectItem>
                <SelectItem value="company">Company</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow k="competition" dossier={dossier}
            onSkip={(r) => skip("competition", r)} onUnskip={() => unskip("competition")}>
            <Select value={dossier.competition ?? ""} onValueChange={(v) => patch({ competition: v as Dossier["competition"] })}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="visiting">Visiting others</SelectItem>
                <SelectItem value="booked">Booked elsewhere</SelectItem>
                <SelectItem value="comparing">Comparing</SelectItem>
                <SelectItem value="none">No competition</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow k="objection" dossier={dossier}
            onSkip={(r) => skip("objection", r)} onUnskip={() => unskip("objection")}>
            <Select value={dossier.objection ?? ""} onValueChange={(v) => patch({ objection: v as Dossier["objection"] })}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="price">Price</SelectItem>
                <SelectItem value="distance">Distance</SelectItem>
                <SelectItem value="food">Food</SelectItem>
                <SelectItem value="deposit">Deposit</SelectItem>
                <SelectItem value="parents">Parents</SelectItem>
                <SelectItem value="friends">Friends</SelectItem>
                <SelectItem value="timing">Timing</SelectItem>
                <SelectItem value="exploring">Still exploring</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </div>
      </Section>

      {/* NEW · Location & commute — surfaces the office/college/commute fields
          that were in the type but not on the form. Big wins for match quality. */}
      <Section
        title="Location & commute"
        subtitle="Commute is the #1 predictor of stay-length. Capture it early."
        banner={{
          why: "Commute kills stays — filter by it before showing options.",
          admin: "Zone-brain reallocates high-demand localities.",
          tcm: "Every property gets a live travel-time chip.",
          client: "No 90-min-commute surprises after move-in.",
        }}
      >
        <div className="grid grid-cols-3 gap-3">
          <FieldRow k="officeLocation" dossier={dossier}
            onSkip={(r) => skip("officeLocation", r)} onUnskip={() => unskip("officeLocation")}>
            <Input value={dossier.officeLocation ?? ""}
              placeholder="e.g. Manyata, EGL, Whitefield"
              onChange={(e) => patch({ officeLocation: e.target.value })} />
          </FieldRow>
          <FieldRow k="collegeLocation" dossier={dossier}
            onSkip={(r) => skip("collegeLocation", r)} onUnskip={() => unskip("collegeLocation")}>
            <Input value={dossier.collegeLocation ?? ""}
              placeholder="e.g. Christ, PES, NIFT"
              onChange={(e) => patch({ collegeLocation: e.target.value })} />
          </FieldRow>
          <FieldRow k="travelTimeMinutes" dossier={dossier}
            onSkip={(r) => skip("travelTimeMinutes", r)} onUnskip={() => unskip("travelTimeMinutes")}>
            <Input type="number" min={5} step={5}
              placeholder="min" value={dossier.travelTimeMinutes ?? ""}
              onChange={(e) => patch({ travelTimeMinutes: Number(e.target.value) || undefined })} />
          </FieldRow>
          <FieldRow k="preferredLocality" dossier={dossier}
            onSkip={(r) => skip("preferredLocality", r)} onUnskip={() => unskip("preferredLocality")}>
            <Input value={dossier.preferredLocality ?? ""}
              placeholder="Top-choice locality"
              onChange={(e) => patch({ preferredLocality: e.target.value })} />
          </FieldRow>
          <FieldRow k="alternativeLocality" dossier={dossier}
            onSkip={(r) => skip("alternativeLocality", r)} onUnskip={() => unskip("alternativeLocality")}>
            <Input value={dossier.alternativeLocality ?? ""}
              placeholder="Fallback locality"
              onChange={(e) => patch({ alternativeLocality: e.target.value })} />
          </FieldRow>
        </div>
      </Section>

      {/* NEW · Lifestyle — occupation, food, duration */}
      <Section
        title="Lifestyle"
        subtitle="Food + stay-length + employer often decide the room."
        banner={{
          why: "Food / duration is a hard filter and a churn predictor.",
          admin: "Segments veg-only demand + LTV forecast.",
          tcm: "Skips non-matching properties on message #1.",
          client: "No 'no veg' or wrong-lock-in surprise.",
        }}
      >
        <div className="grid grid-cols-3 gap-3">
          <FieldRow k="occupation" dossier={dossier}
            onSkip={(r) => skip("occupation", r)} onUnskip={() => unskip("occupation")}>
            <Input value={dossier.occupation ?? ""}
              placeholder="Employer / college"
              onChange={(e) => patch({ occupation: e.target.value })} />
          </FieldRow>
          <FieldRow k="foodPreference" dossier={dossier}
            onSkip={(r) => skip("foodPreference", r)} onUnskip={() => unskip("foodPreference")}>
            <Select value={dossier.foodPreference ?? ""} onValueChange={(v) => patch({ foodPreference: v as Dossier["foodPreference"] })}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="veg">Veg</SelectItem>
                <SelectItem value="non-veg">Non-veg</SelectItem>
                <SelectItem value="any">Any</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow k="duration" dossier={dossier}
            onSkip={(r) => skip("duration", r)} onUnskip={() => unskip("duration")}>
            <Select value={dossier.duration ?? ""} onValueChange={(v) => patch({ duration: v })}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1m">1 month</SelectItem>
                <SelectItem value="3m">3 months</SelectItem>
                <SelectItem value="6m">6 months</SelectItem>
                <SelectItem value="12m">12 months</SelectItem>
                <SelectItem value="long">Long-term (2y+)</SelectItem>
                <SelectItem value="unsure">Unsure</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </div>
      </Section>

      {/* NEW · Media sent — checkboxes proving what actually reached the lead */}
      <Section
        title="What we sent · shortlist"
        subtitle="Track P1–P4 pitched + which assets landed. Halves 'we didn't get anything'."
        banner={{
          why: "Prevents re-sending and settles 'nothing was shared' disputes.",
          admin: "Audit trail per lead per asset.",
          tcm: "Never send the same PDF twice, always know what's next.",
          client: "Not spammed the same PDF twice.",
        }}
      >
        <div className="grid grid-cols-4 gap-3">
          {(["p1", "p2", "p3", "p4"] as const).map((k) => (
            <FieldRow key={k} k={k} dossier={dossier}
              onSkip={(r) => skip(k, r)} onUnskip={() => unskip(k)}>
              <Input value={(dossier[k] as string) ?? ""}
                placeholder={`Property ${k.slice(1)}`}
                onChange={(e) => patch({ [k]: e.target.value } as Partial<Dossier>)} />
            </FieldRow>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {([
            { k: "pdfSent",      label: "📄 PDF sent" },
            { k: "videoSent",    label: "🎥 Video sent" },
            { k: "locationSent", label: "📍 Location sent" },
          ] as const).map((t) => {
            const active = Boolean(dossier[t.k]);
            return (
              <button key={t.k} type="button"
                onClick={() => patch({ [t.k]: !active } as Partial<Dossier>)}
                className={cn(
                  "text-[11px] px-2 py-1 rounded-full border transition inline-flex items-center gap-1",
                  active
                    ? "border-success/50 bg-success/10 text-success"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}>
                {active && <span className="text-[10px]">✓</span>}
                {t.label}
              </button>
            );
          })}
        </div>
        <WhyCaption
          why="Toggle after you actually send the asset — becomes the audit line."
          admin="Every dispute has evidence."
          tcm="See at a glance what's still to send."
          client="One clean thread, no duplicate blasts."
        />
      </Section>

      <div>
        <Label className="text-xs">Notes / properties sent (P1, P2, P3, PDF, video)</Label>
        <Textarea rows={2} value={dossier.objectionNotes ?? ""}
          onChange={(e) => patch({ objectionNotes: e.target.value })}
          placeholder="e.g. Sent P1 Bliss + P2 Metrofield + PDF" />
        <WhyCaption
          why="Free-text catch-all for anything the structured fields don't cover."
          admin="Searchable across the pipeline."
          tcm="Fast dump; you can structure later."
          client="Their exact ask stays intact for the next TCM."
        />
      </div>

      <div className="flex items-center justify-between border-t pt-3">
        <div className="text-xs text-muted-foreground">
          {missing.length === 0
            ? "All fields captured or skipped — ready to match property."
            : `${missing.length} field${missing.length > 1 ? "s" : ""} remaining: ${
                missing.slice(0, 3).map((k) => DOSSIER_FIELD_LABELS[k as string] ?? k).join(", ")
              }${missing.length > 3 ? "…" : ""}`}
        </div>
        <Button
          size="sm"
          disabled={missing.length > 0}
          onClick={() => advanceStage(leadId, "MATCHED", { userId: user.id, userName: user.name })}
        >
          Lock dossier → Property match
        </Button>
      </div>

      {/* Lifecycle 15x — group composition, revival cycles, follow-ups, commitments, scenarios */}
      <LifecyclePanel leadId={leadId} totalBudget={dossier.budget} />
    </div>
  );
}

/* ─────────── helpers ─────────── */

function Section({
  title, subtitle, children, banner,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  banner?: { why: string; admin?: string; tcm?: string; client?: string };
}) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">{title}</div>
        {subtitle && <div className="text-[10px] text-muted-foreground/70">{subtitle}</div>}
      </div>
      {banner && (
        <WhySectionBanner title={title} why={banner.why} admin={banner.admin} tcm={banner.tcm} client={banner.client} />
      )}
      {children}
    </div>
  );
}

function FieldRow({
  k, dossier, children, inline, onSkip, onUnskip,
}: {
  k: FieldKey;
  dossier: Dossier;
  children: React.ReactNode;
  inline?: boolean;
  onSkip: (reason: string) => void;
  onUnskip: () => void;
}) {
  const status = dossierFieldStatus(dossier, k);
  const label = DOSSIER_FIELD_LABELS[k as string] ?? String(k);
  const skipReason = dossier.skipped?.[k as string];
  const why = WHY_MAP[k as string];

  const Dot =
    status === "filled"  ? <CheckCircle2 className="h-3 w-3 text-success" />
  : status === "skipped" ? <MinusCircle  className="h-3 w-3 text-warning" />
  :                        <Circle       className="h-3 w-3 text-destructive" />;

  return (
    <div className={cn(
      "space-y-1 rounded-md p-1.5 -m-1.5 transition",
      status === "empty"   && "bg-destructive/5",
      status === "skipped" && "bg-warning/5",
    )}>
      <div className="flex items-center justify-between">
        <div className={cn("flex items-center gap-1.5", inline && "text-xs")}>
          {Dot}
          <Label className="text-[11px] leading-none">{label}</Label>
          {status === "skipped" && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-warning/20 text-warning">
              later · {skipReason}
            </span>
          )}
        </div>
        {status === "skipped" ? (
          <button type="button" onClick={onUnskip}
            className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5">
            <X className="h-2.5 w-2.5" /> undo
          </button>
        ) : status === "empty" ? (
          <SkipPopover onSkip={onSkip} />
        ) : null}
      </div>
      <div>{children}</div>
      {why && (
        <WhyCaption
          compact
          why={why.why}
          admin={why.admin}
          tcm={why.tcm}
          client={why.client}
        />
      )}
    </div>
  );
}

function SkipPopover({ onSkip }: { onSkip: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const submit = (r: string) => {
    onSkip(r || "ask later");
    setReason(""); setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5">
          <SkipForward className="h-2.5 w-2.5" /> skip
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Why defer?</div>
        <div className="flex flex-wrap gap-1">
          {["will ask later", "not urgent", "waiting on lead", "not comfortable asking"].map((r) => (
            <button key={r} type="button" onClick={() => submit(r)}
              className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-muted">
              {r}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <Input className="h-7 text-xs" placeholder="Custom reason"
            value={reason} onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit(reason)} />
          <Button size="sm" className="h-7 text-[10px] px-2" onClick={() => submit(reason)}>OK</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
