import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CheckCircle2, ClipboardCopy, Clock3, Flag, Goal,
  Building2, Hand, MessageCircle, Phone, PhoneCall, PhoneOff, PlayCircle, PlusCircle, ShieldCheck, Timer,
  Sparkles, ArrowRight, UserCheck, Check, Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useMovementSync } from "@/movement/bridge";
import { seedMovement } from "@/movement/seed";
import { useMovement } from "@/movement/store";
import { DraftChip, JourneyTimeline, WorkPanel } from "@/movement/components";
import { totals } from "@/movement/metrics";
import { NEXT_ACTION_LABEL, OPERATORS, type CallResult, type NextActionKind } from "@/movement/types";
import { toast } from "sonner";
import { CARE_PLAYBOOKS, GOAL_TITLE, ROUND_COPY, type CareGoal, type CareRole, type CareRound } from "./playbooks";
import { ManualDraftPanel, type ManualCandidate, type NewLeadInput } from "./ManualDraft";
import { useIdentityStore } from "@/lib/lead-identity/store";
import { actualForGoal, callStats, queueForGoal, resultStatus } from "./results";
import { optionById, propertyOptions, propertyProgress, rankedForCustomer } from "./properties";
import { todaysCommitment, useMovementCare, type DailyCommitment } from "./store";
import { debriefMessage } from "./debrief";
import { CheckpointPanel } from "./CheckpointPanel";
import { persistCareAction } from "./persistence";
import { loadAllExecutionState } from "@/e2eplus/persistence";

const GOAL_TONE: Record<CareGoal, string> = {
  FIND: "border-info/40 bg-info/10 text-info",
  SCHEDULE: "border-warning/40 bg-warning/10 text-warning",
  COMPLETE: "border-success/40 bg-success/10 text-success",
  CLOSE: "border-primary/40 bg-primary/10 text-primary",
};

const GOAL_NEXT: Record<CareGoal, NextActionKind> = {
  FIND: "call",
  SCHEDULE: "confirm-tour",
  COMPLETE: "post-tour-call",
  CLOSE: "collect-payment",
};

function dueForGoal(goal: CareGoal) {
  const minutes = goal === "CLOSE" ? 60 : goal === "COMPLETE" ? 90 : goal === "SCHEDULE" ? 120 : 180;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function MovementCare() {
  useEffect(() => {
    seedMovement();
    void loadAllExecutionState().then((execs) => {
      const mvStore = useMovement.getState();
      for (const [leadId, exec] of Object.entries(execs)) {
        if (exec.nextAction || exec.lastOutcome || exec.ownerName) {
          const kind = (exec.nextAction as NextActionKind) || "call";
          mvStore.patch(leadId, {
            primaryOwnerId: exec.ownerId || undefined,
            primaryOwnerName: exec.ownerName || undefined,
            nextAction: exec.nextAction ? {
              kind,
              dueAt: exec.nextActionAt || exec.followUpAt || new Date().toISOString(),
              ownerId: exec.ownerId || mvStore.actor.id,
              ownerName: exec.ownerName || mvStore.actor.name,
              note: exec.lastOutcome || "Authoritative execution",
            } : undefined,
          });
        }
      }
    }).catch((err: unknown) => {
      console.warn("Could not hydrate execution state from Supabase:", err);
    });
  }, []);
  const { list, nameOf, me } = useMovementSync();
  const events = useMovement((state) => state.events);
  const setActor = useMovement((state) => state.setActor);
  const mv = useMovement();
  const storedCommitment = useMovementCare((state) => state.commitment);
  const commitment = todaysCommitment(storedCommitment);
  const reports = useMovementCare((state) => state.reports);
  const commit = useMovementCare((state) => state.commit);
  const report = useMovementCare((state) => state.report);
  const clearCommitment = useMovementCare((state) => state.clearCommitment);
  const saveDebrief = useMovementCare((state) => state.saveDebrief);
  const markDebriefSent = useMovementCare((state) => state.markDebriefSent);
  const debriefs = useMovementCare((state) => state.debriefs);
  const [role, setRole] = useState<CareRole>(commitment?.role ?? "flow-ops");
  const [goal, setGoal] = useState<CareGoal>(commitment?.goal ?? "FIND");
  const [commitCount, setCommitCount] = useState(commitment?.commitCount ?? CARE_PLAYBOOKS[role].stages[0].dayCount);
  const [support, setSupport] = useState(commitment?.supportNeeded ?? "");
  const [selected, setSelected] = useState<string | null>(null);
  const [round, setRound] = useState<CareRound>("BUILD");
  const [moved, setMoved] = useState("");
  const [stuck, setStuck] = useState("");
  const [need, setNeed] = useState("");
  const [showPlaybook, setShowPlaybook] = useState(false);
  const [aimProperties, setAimProperties] = useState<string[]>([]);
  const [propertyQuery, setPropertyQuery] = useState("");
  const [debriefFor, setDebriefFor] = useState<{ ulid: string; code: string } | null>(null);
  const [showManual, setShowManual] = useState(false);
  const manualMode = useMovementCare((state) => state.manualMode);
  const manualSize = useMovementCare((state) => state.manualSize);
  const manualList = useMovementCare((state) => state.manualList);
  const setManualMode = useMovementCare((state) => state.setManualMode);
  const setManualSize = useMovementCare((state) => state.setManualSize);
  const setManualList = useMovementCare((state) => state.setManualList);
  const addToManual = useMovementCare((state) => state.addToManual);
  const removeFromManual = useMovementCare((state) => state.removeFromManual);
  const replaceInManual = useMovementCare((state) => state.replaceInManual);
  const clearManual = useMovementCare((state) => state.clearManual);
  const draftStartedAt = useMovementCare((state) => state.draftStartedAt);
  const startRollingDraft = useMovementCare((state) => state.startRollingDraft);
  const stopDraftClock = useMovementCare((state) => state.stopDraftClock);
  const [showFormat, setShowFormat] = useState(false);
  const [clockTick, setClockTick] = useState(0);
  const createLead = useIdentityStore((state) => state.createLead);

  // ── One-Tap Care & Auto-Advance State ─────────────────────────────────────
  const [lastGeneratedCustomerMsg, setLastGeneratedCustomerMsg] = useState<string | null>(null);
  const [lastGeneratedWrapUp, setLastGeneratedWrapUp] = useState<string | null>(null);
  const [completedUlids, setCompletedUlids] = useState<string[]>([]);
  const [isSavingOutcome, setIsSavingOutcome] = useState(false);
  const advancingRef = useRef(false);

  useEffect(() => {
    if (!draftStartedAt) return;
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [draftStartedAt]);

  const elapsed = useMemo(() => {
    if (!draftStartedAt) return null;
    void clockTick;
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(draftStartedAt).getTime()) / 1000));
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }, [draftStartedAt, clockTick]);

  const activeRole = commitment?.role ?? role;
  const activeGoal = commitment?.goal ?? goal;
  const playbook = CARE_PLAYBOOKS[activeRole];
  const stage = playbook.stages.find((item) => item.goal === activeGoal) ?? playbook.stages[0];
  const systemQueue = useMemo(() => queueForGoal(activeGoal, list), [activeGoal, list]);
  const queue = useMemo(() => {
    if (!manualMode) return systemQueue;
    const byId = new Map(systemQueue.map((item) => [item.ulid, item]));
    return manualList.map((ulid) => byId.get(ulid)).filter(Boolean) as typeof systemQueue;
  }, [manualMode, manualList, systemQueue]);
  const candidates = useMemo<ManualCandidate[]>(() => systemQueue.map((item) => {
    const info = nameOf.get(item.ulid);
    return {
      ulid: item.ulid,
      name: info?.name ?? item.ulid,
      phone: info?.phone ?? item.state.phone ?? "",
      area: info?.area ?? "—",
      note: item.reason,
      bucket: item.bucket,
    };
  }), [systemQueue, nameOf]);
  const actual = useMemo(() => actualForGoal(activeGoal, list, events), [activeGoal, list, events]);
  const total = useMemo(() => totals(list, events), [list, events]);
  const calls = useMemo(() => callStats(events), [events]);
  const aimed = commitment?.closingPropertyIds ?? aimProperties;
  const aimProgress = useMemo(() => propertyProgress(aimed, list), [aimed, list]);
  const progress = commitment ? Math.min(100, Math.round((actual / Math.max(commitment.commitCount, 1)) * 100)) : 0;
  const selectedState = selected ? list.find((item) => item.ulid === selected) : undefined;
  const selectedResult = selectedState ? resultStatus(selectedState) : null;
  const today = new Date().toISOString().slice(0, 10);
  const todaysReports = reports.filter((item) => item.date === today);
  const weakRounds = todaysReports.filter((item) => item.actual < item.committed * 0.65).length;
  const todaysDebriefs = debriefs.filter((item) => item.date === today);

  useEffect(() => {
    const roleOperator = activeRole === "tcm" ? OPERATORS.find((operator) => operator.role === "tcm") : undefined;
    setActor(roleOperator ?? { id: me.id, name: me.name, role: "flow-ops", zone: "KORA CORE" });
  }, [activeRole, me.id, me.name, setActor]);

  useEffect(() => {
    if (!selected && queue.length) setSelected(queue[0].ulid);
  }, [queue, selected]);

  const chooseRole = (nextRole: CareRole) => {
    setRole(nextRole);
    const first = CARE_PLAYBOOKS[nextRole].stages[0];
    setGoal(first.goal);
    setCommitCount(first.dayCount);
  };

  const chooseGoal = (nextGoal: CareGoal) => {
    setGoal(nextGoal);
    const nextStage = CARE_PLAYBOOKS[role].stages.find((item) => item.goal === nextGoal);
    if (nextStage) setCommitCount(nextStage.dayCount);
  };

  const startDay = () => {
    commit({ role, goal, commitCount: Math.max(1, commitCount), supportNeeded: support.trim(), closingPropertyIds: aimProperties });
    toast.success(`${goal} result committed for today`);
  };

  const createManualLead = (input: NewLeadInput) => {
    const lead = createLead({
      name: input.name.trim() || "Unnamed lead",
      phone: input.phone.trim(),
      email: "",
      location: input.area.trim(),
      areas: input.area.trim() ? [input.area.trim()] : [],
      fullAddress: "",
      budget: input.budget.trim(),
      moveIn: input.moveIn.trim(),
      type: "",
      room: "",
      need: "",
      specialReqs: input.note.trim(),
      inBLR: null,
      zone: "",
      rawSource: "Added by hand in Movement CARE",
    });
    addToManual(lead.ulid);
    setManualMode(true);
    toast.success(`${lead.name} added by hand and put in your draft`);
  };

  const fillManualDemo = () => {
    const picked = new Set(manualList);
    for (const item of systemQueue) {
      if (picked.size >= manualSize) break;
      picked.add(item.ulid);
    }
    setManualList(Array.from(picked));
    setManualMode(true);
    toast.success(`Demo draft built — ${Math.min(picked.size, manualSize)} leads picked by hand`);
  };

  const acceptDraft = () => {
    if (!commitment || !selectedState) return;
    const code = selectedState.waDraft ?? (activeGoal === "CLOSE" ? "D1" : activeGoal === "SCHEDULE" ? "D2" : "D3");
    mv.draft(selectedState.ulid, code);
    mv.attemptClaim(selectedState.ulid, activeGoal === "SCHEDULE" || activeGoal === "COMPLETE" ? "tour" : activeGoal === "CLOSE" ? "closing" : "work", stage.outcome);
    mv.setNextAction(selectedState.ulid, {
      kind: GOAL_NEXT[activeGoal],
      dueAt: dueForGoal(activeGoal),
      ownerId: selectedState.primaryOwnerId || mv.actor.id,
      ownerName: selectedState.primaryOwnerId ? selectedState.primaryOwnerName : mv.actor.name,
      note: `${activeGoal}: ${stage.outcome}`,
    });
    setDebriefFor({ ulid: selectedState.ulid, code });
    toast.success(`${code} done — write the wrap-up and send it on WhatsApp`);
  };

  const startEmptyDraft = () => {
    startRollingDraft(manualSize);
    setSelected(null);
    setShowManual(true);
    toast.success(`Draft clock started — ${manualSize} empty rows, fill them one by one while you work`);
  };

  /** The exact WhatsApp message, built live as the person types — nothing is saved. */
  const previewMessage = (input: { done: string; wentWell: string; wentBadly: string; problems: string }) => {
    if (!commitment || !selectedState) return "";
    return debriefMessage({
      ...input,
      customerName: nameOf.get(selectedState.ulid)?.name ?? selectedState.ulid,
      draftCode: debriefFor?.code ?? selectedState.crmDraft ?? "D1",
      goal: activeGoal,
      operatorName: mv.actor.name,
      resultNow: actual,
      commitCount: commitment.commitCount,
      property: selectedState.tourProperty ?? undefined,
      nextStep: selectedState.nextAction ? NEXT_ACTION_LABEL[selectedState.nextAction.kind] : undefined,
      dueAt: selectedState.nextAction?.dueAt,
    });
  };

  const finishDebrief = (input: { done: string; wentWell: string; wentBadly: string; problems: string }) => {
    if (!commitment || !selectedState || !debriefFor) return;
    const message = previewMessage(input);
    const saved = saveDebrief({
      ulid: selectedState.ulid,
      customerName: nameOf.get(selectedState.ulid)?.name ?? selectedState.ulid,
      draftCode: debriefFor.code,
      goal: activeGoal,
      message,
      ...input,
    });
    mv.log(selectedState.ulid, "note", `${debriefFor.code} wrap-up · done: ${input.done || "—"} · well: ${input.wentWell || "—"} · badly: ${input.wentBadly || "—"} · problem: ${input.problems || "none"}`);
    return saved;
  };

  const copyMessage = async (id: string, message: string) => {
    try {
      await navigator.clipboard.writeText(message);
      markDebriefSent(id);
      toast.success("Copied — paste it in the team WhatsApp group");
    } catch {
      toast.error("Could not copy. Select the text and copy it manually.");
    }
  };

  const dial = () => {
    if (!selectedState) return;
    mv.startCall(selectedState.ulid);
    toast.info("Call started — log the outcome when it ends");
  };

  const endCall = (result: CallResult) => {
    if (!selectedState) return;
    mv.logCall(selectedState.ulid, result);
    if (result !== "connected" && result !== "wrong-number") {
      mv.setNextAction(selectedState.ulid, {
        kind: "call",
        dueAt: new Date(Date.now() + 45 * 60_000).toISOString(),
        ownerId: selectedState.primaryOwnerId || mv.actor.id,
        ownerName: selectedState.primaryOwnerName || mv.actor.name,
        note: `Retry call — ${result}`,
      });
    }
    toast.success(result === "connected" ? "Connected call logged" : `Call logged as ${result}`);
  };

  const aimProperty = (propertyId: string) => {
    if (!selectedState) return;
    const option = optionById(propertyId);
    if (!option) return;
    mv.patch(selectedState.ulid, { tourProperty: option.name });
    mv.log(selectedState.ulid, "note", `Property to close: ${option.name} · ${option.area} · from ₹${option.fromPrice.toLocaleString("en-IN")}`);
    mv.setNextAction(selectedState.ulid, {
      kind: "send-property",
      dueAt: dueForGoal(activeGoal),
      ownerId: selectedState.primaryOwnerId || mv.actor.id,
      ownerName: selectedState.primaryOwnerName || mv.actor.name,
      note: `Send ${option.name} and lock the tour`,
    });
    toast.success(`${option.name} locked as the property to close`);
  };

  const saveReport = () => {
    if (!commitment) return;
    report({
      round,
      role: commitment.role,
      goal: commitment.goal,
      actual,
      committed: commitment.commitCount,
      moved: moved.trim(),
      stuck: stuck.trim(),
      need: need.trim(),
    });
    mv.snapshot({
      label: round === "BUILD" ? "1PM" : round === "MOVE" ? "5PM" : "EOD",
      operatorId: mv.actor.id,
      totals: total as unknown as Record<string, number>,
      required: { [commitment.goal.toLowerCase()]: commitment.commitCount },
      status: actual >= commitment.commitCount ? "ON TRACK" : "BEHIND",
      mainLeak: stuck.trim() || "No blocker reported",
      inference: `${commitment.goal} ${actual}/${commitment.commitCount} · ${moved.trim() || "movement pending"}`,
    });
    setMoved("");
    setStuck("");
    setNeed("");
    toast.success(`${ROUND_COPY[round].label} progress reported`);
  };

  // ── One-Tap Care Execution & Advance Handlers ──────────────────────────────
  const advanceToNextCustomer = () => {
    if (!selected || queue.length === 0) return;
    const currentIndex = queue.findIndex((item) => item.ulid === selected);
    if (currentIndex === -1) return;

    if (currentIndex < queue.length - 1) {
      const nextUlid = queue[currentIndex + 1].ulid;
      setSelected(nextUlid);
      const nextInfo = nameOf.get(nextUlid);
      toast.info(`Advanced to next: ${nextInfo?.name || nextUlid}`);
    } else {
      toast.success("All customers in the queue have been reviewed!");
    }
  };

  const triggerOverdueTest = () => {
    if (!selectedState) return;
    const pastDueIso = new Date(Date.now() - 3600_000).toISOString(); // 1 hour in the past
    mv.setNextAction(selectedState.ulid, {
      kind: "call",
      dueAt: pastDueIso,
      ownerId: mv.actor.id,
      ownerName: mv.actor.name,
      note: "SLA Overdue verification test",
    });
    toast.warning("Simulated past deadline: Customer is now marked 🔴 OVERDUE");
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const activeTag = (document.activeElement?.tagName || "").toLowerCase();
        if (activeTag === "input" || activeTag === "textarea" || activeTag === "select") {
          return;
        }
        if (advancingRef.current) return;
        advancingRef.current = true;
        advanceToNextCustomer();
        setTimeout(() => {
          advancingRef.current = false;
        }, 400);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selected, queue, nameOf]);

  const handleOneTapOutcome = async (presetKey: "tour" | "options" | "call" | "quote" | "cold") => {
    if (!selectedState) return;
    setIsSavingOutcome(true);

    const customerName = nameOf.get(selectedState.ulid)?.name ?? selectedState.ulid;
    const customerArea = nameOf.get(selectedState.ulid)?.area ?? "Bengaluru";
    const propertyName = selectedState.tourProperty || (aimed[0] ? optionById(aimed[0])?.name : "Gharpayy Managed Home") || "Gharpayy Managed Home";

    let outcomeLabel = "";
    let situation: "TOUR SCHEDULED" | "PROPERTY OPTIONS" | "CALL REQUIRED" | "TOKEN PENDING" | "LOST" = "CALL REQUIRED";
    let nextActionKind: NextActionKind = "call";
    let nextActionNote = "";
    let dueMinutes = 120;
    let customerMsg = "";
    let wrapUpData = { done: "", wentWell: "", wentBadly: "", problems: "none" };

    if (presetKey === "tour") {
      outcomeLabel = "Tour Booked · Tomorrow 11 AM";
      situation = "TOUR SCHEDULED";
      nextActionKind = "confirm-tour";
      nextActionNote = `Tour confirmed for tomorrow 11 AM at ${propertyName}`;
      dueMinutes = 180;
      const tourTimeIso = new Date(Date.now() + 86400000).toISOString();
      mv.scheduleTour(selectedState.ulid, tourTimeIso, propertyName);
      mv.confirmTour(selectedState.ulid);
      customerMsg = `Hi ${customerName}, your in-person tour for ${propertyName} (${customerArea}) is confirmed for tomorrow at 11:00 AM! 🏠 Our property manager will assist you on-site. Let us know if you need location directions.`;
      wrapUpData = {
        done: `Scheduled & confirmed tour for tomorrow 11 AM at ${propertyName}`,
        wentWell: "Customer confirmed move-in timeline and budget criteria",
        wentBadly: "None",
        problems: "none",
      };
    } else if (presetKey === "options") {
      outcomeLabel = "Qualified · Options Sent";
      situation = "PROPERTY OPTIONS";
      nextActionKind = "send-property";
      nextActionNote = `Shared curated properties matching budget in ${customerArea}`;
      dueMinutes = 120;
      mv.qualify(selectedState.ulid, true);
      mv.setStage(selectedState.ulid, "matched", "Properties shared");
      customerMsg = `Hi ${customerName}, based on your budget and preferred location (${customerArea}), here are tailored room options for you:\n• ${propertyName}\n• Salarpuria Sattva\nLet me know which one you'd like to visit! 🔑`;
      wrapUpData = {
        done: `Qualified requirements and shared top matching properties in ${customerArea}`,
        wentWell: "Inventory matches budget",
        wentBadly: "Comparing with other rentals",
        problems: "none",
      };
    } else if (presetKey === "call") {
      outcomeLabel = "Connected · Call in 2h";
      situation = "CALL REQUIRED";
      nextActionKind = "call";
      nextActionNote = "Connected with lead; callback scheduled in 2h";
      dueMinutes = 120;
      mv.logCall(selectedState.ulid, "connected", "Connected, callback requested in 2h");
      customerMsg = `Hi ${customerName}, thank you for speaking with us! As discussed, I will reconnect with you in 2 hours with available room inventory. 📱`;
      wrapUpData = {
        done: "Connected via phone call; customer requested callback in 2h",
        wentWell: "Customer was receptive and shared preferences",
        wentBadly: "Currently busy in office",
        problems: "none",
      };
    } else if (presetKey === "quote") {
      outcomeLabel = "Booking Intent · Quote Sent";
      situation = "TOKEN PENDING";
      nextActionKind = "collect-payment";
      nextActionNote = `Booking quote sent for ${propertyName}; token deposit pending`;
      dueMinutes = 60;
      mv.prebook(selectedState.ulid, "payment-intent");
      mv.sendQuote(selectedState.ulid);
      customerMsg = `Hi ${customerName}, your booking quote for ${propertyName} has been sent! To lock the room and reserve your bed, please complete the token reservation within the next hour: https://gharpayy.com/pay 💳`;
      wrapUpData = {
        done: `Generated and sent formal booking quote for ${propertyName}`,
        wentWell: "Agreed on commercial terms and move-in date",
        wentBadly: "Payment pending verification",
        problems: "none",
      };
    } else {
      outcomeLabel = "Not Interested / Cold";
      situation = "LOST";
      nextActionKind = "recheck-later";
      nextActionNote = "Customer not interested or dropped to nurture";
      dueMinutes = 1440;
      mv.exit(selectedState.ulid, "no-response", "Customer dropped to nurture");
      customerMsg = `Hi ${customerName}, noted your preference! Whenever you are looking for co-living options in Bengaluru again, reach out anytime. Have a great day! 🌟`;
      wrapUpData = {
        done: "Lead marked cold / closed as not actionable",
        wentWell: "Clean exit",
        wentBadly: "Budget mismatch or already rented elsewhere",
        problems: "none",
      };
    }

    const dueAt = new Date(Date.now() + dueMinutes * 60_000).toISOString();

    // Update Next Action on Movement state
    mv.setNextAction(selectedState.ulid, {
      kind: nextActionKind,
      dueAt,
      ownerId: mv.actor.id,
      ownerName: mv.actor.name,
      note: nextActionNote,
    });

    mv.log(selectedState.ulid, "note", `1-Tap: ${outcomeLabel} (Next: ${nextActionKind} due in ${dueMinutes}m)`);

    // Auto-generate debrief message for team
    const wrapUpMessage = debriefMessage({
      customerName,
      draftCode: selectedState.crmDraft ?? "D1",
      goal: activeGoal,
      operatorName: mv.actor.name,
      resultNow: actual + 1,
      commitCount: commitment?.commitCount ?? 30,
      property: propertyName,
      nextStep: NEXT_ACTION_LABEL[nextActionKind] ?? nextActionKind,
      dueAt,
      ...wrapUpData,
    });

    saveDebrief({
      ulid: selectedState.ulid,
      customerName,
      draftCode: selectedState.crmDraft ?? "D1",
      goal: activeGoal,
      message: wrapUpMessage,
      ...wrapUpData,
    });

    setLastGeneratedCustomerMsg(customerMsg);
    setLastGeneratedWrapUp(wrapUpMessage);
    setCompletedUlids((prev) => Array.from(new Set([...prev, selectedState.ulid])));

    // Copy customer message to clipboard immediately
    try {
      await navigator.clipboard.writeText(customerMsg);
      toast.success(`⚡ "${outcomeLabel}" logged & WhatsApp message copied!`);
    } catch {
      toast.success(`⚡ "${outcomeLabel}" logged!`);
    }

    // Authoritative Supabase & Audit persistence
    try {
      const saveRes = await persistCareAction({
        leadId: selectedState.ulid,
        leadName: customerName,
        phone: selectedState.phone,
        actor: { id: mv.actor.id, name: mv.actor.name },
        outcomeCode: presetKey,
        outcomeLabel,
        stage: selectedState.stage,
        situation,
        nextActionKind,
        nextActionNote,
        dueAt,
        ownerId: mv.actor.id,
        ownerName: mv.actor.name,
        customerMessage: customerMsg,
        internalWrapUp: wrapUpMessage,
        tourProperty: propertyName,
      });

      if (saveRes.ok) {
        toast.success(`⚡ Outcome saved & WhatsApp message copied!`);
        // AUTO-ADVANCE: Advances to the next customer ONLY after persistence succeeds
        setTimeout(() => {
          advanceToNextCustomer();
        }, 500);
      } else {
        toast.error(`Backend persistence failed: ${saveRes.error || "Unknown error"}. Not advancing.`);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Persistence error:", errorMsg);
      toast.error(`Persistence error: ${errorMsg}. Not advancing.`);
    } finally {
      setIsSavingOutcome(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-[560px] flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b bg-card px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary"><Goal className="h-4 w-4" /></div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold">Movement CARE</h1>
            <p className="text-[10px] text-muted-foreground">Draft Vision signal → accountable movement → accepted result</p>
          </div>
          <div className="ml-auto flex items-center gap-1 rounded-md border p-0.5">
            {(["flow-ops", "tcm"] as CareRole[]).map((item) => (
              <Button key={item} size="sm" variant={activeRole === item ? "default" : "ghost"} className="h-7 px-2 text-[10px]"
                disabled={Boolean(commitment)} onClick={() => chooseRole(item)}>
                {CARE_PLAYBOOKS[item].label}
              </Button>
            ))}
          </div>
          {elapsed ? (
            <Badge variant="outline" className="h-7 gap-1 border-primary/50 px-2 text-[10px] font-semibold text-primary">
              <Timer className="h-3 w-3" /> Draft running {elapsed} · {manualList.length}/{manualSize} filled
              <button type="button" className="ml-1 underline" onClick={stopDraftClock}>stop</button>
            </Badge>
          ) : (
            <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={startEmptyDraft}>
              <PlayCircle className="h-3 w-3" /> Start draft · {manualSize} empty rows
            </Button>
          )}
          <Button size="sm" variant={manualMode ? "default" : "outline"} className="h-7 text-[10px]" onClick={() => setShowManual(true)}>
            <Hand className="h-3 w-3" /> Draft by hand{manualMode ? ` · ${manualList.length}/${manualSize}` : ""}
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => setShowFormat((value) => !value)}>
            <MessageCircle className="h-3 w-3" /> WhatsApp update format
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => setShowPlaybook((value) => !value)}>
            <ShieldCheck className="h-3 w-3" /> Playbook
          </Button>
        </div>

        {commitment && (
          <div className="mt-2 grid grid-cols-[minmax(180px,1fr)_repeat(6,minmax(70px,auto))] gap-1.5 overflow-x-auto">
            <div className="min-w-[180px] rounded-md border bg-background px-2 py-1.5">
              <div className="flex items-center justify-between gap-2 text-[10px] font-semibold">
                <span>MY RESULT · {activeGoal}</span><span>{actual}/{commitment.commitCount}</span>
              </div>
              <Progress value={progress} className="mt-1 h-1.5" />
            </div>
            <Stat label="Calls" value={calls.dialled} />
            <Stat label="Connected" value={calls.connected} />
            <Stat label="Connect %" value={calls.rate} />
            <Stat label="Drafted" value={total.drafted} />
            <Stat label="Definitely close" value={total.goodLeads} />
            <Stat label="Tours set" value={total.toursScheduled} />
            <Stat label="Tours done" value={total.toursDone} />
            <Stat label="Bookings" value={total.booked} />
            <Stat label="Wrap-ups sent" value={todaysDebriefs.filter((item) => item.sentOnWhatsapp).length} />
            <Stat label="At risk" value={total.breached + total.p0} danger={total.breached + total.p0 > 0} />
          </div>
        )}
      </header>

      {!commitment ? (
        <CommitmentGate role={role} goal={goal} commitCount={commitCount} support={support}
          aimProperties={aimProperties} onAimProperties={setAimProperties}
          query={propertyQuery} onQuery={setPropertyQuery}
          onRole={chooseRole} onGoal={chooseGoal} onCommitCount={setCommitCount} onSupport={setSupport} onStart={startDay} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(420px,1fr)_330px]">
          <section className="flex min-h-0 flex-col overflow-hidden border-r bg-card">
            <div className="border-b px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] font-semibold uppercase text-muted-foreground">
                    {manualMode ? "My hand-picked draft" : "Result queue"}
                  </p>
                  <p className="text-xs font-medium">
                    {manualMode
                      ? `${queue.length} filled · ${Math.max(0, manualSize - queue.length)} empty rows left`
                      : `${stage.meaning} · ${queue.length} open`}
                  </p>
                </div>
                <Badge className={cn("border text-[9px]", GOAL_TONE[activeGoal])}>{activeGoal}</Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => setShowManual(true)}>
                  <Hand className="h-3 w-3" /> Add · remove · replace
                </Button>
                {manualMode && (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setManualMode(false)}>
                    Back to system picks
                  </Button>
                )}
              </div>
            </div>
            <div className="min-h-0 flex-1 divide-y overflow-y-auto">
              {queue.map((item, index) => {
                const info = nameOf.get(item.ulid);
                const status = resultStatus(item.state);
                const isItemOverdue = Boolean(item.state.nextAction?.dueAt && new Date(item.state.nextAction.dueAt).getTime() < Date.now());
                const isWorkedToday = completedUlids.includes(item.ulid);
                return (
                  <Button key={item.ulid} variant="ghost" onClick={() => setSelected(item.ulid)}
                    className={cn("h-auto w-full justify-start rounded-none px-3 py-2 text-left", selected === item.ulid && "bg-primary/10")}>
                    <span className="w-5 shrink-0 font-mono text-[10px] text-muted-foreground">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-semibold">{info?.name ?? item.ulid}</span>
                        <DraftChip code={item.state.crmDraft} />
                        {isWorkedToday && (
                          <span className="text-[9px] font-semibold text-success bg-success/10 px-1 py-0.5 rounded leading-none">✓ Done</span>
                        )}
                      </span>
                      <span className="block truncate text-[10px] font-normal text-muted-foreground">
                        {item.state.waAccount} · {item.reason}
                      </span>
                      <span className={cn("block truncate text-[10px] font-medium", status.accountable ? "text-success" : "text-destructive")}>
                        {status.result}{status.missing.length ? ` · missing ${status.missing.join(", ")}` : " · accountable"}
                      </span>
                    </span>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge variant={item.bucket === "P0" ? "destructive" : "outline"} className="text-[9px]">{item.bucket}</Badge>
                      {isItemOverdue && (
                        <span className="text-[9px] font-bold text-destructive bg-destructive/10 px-1 py-0.5 rounded leading-none animate-pulse">
                          🔴 OVERDUE
                        </span>
                      )}
                    </div>
                  </Button>
                );
              })}
              {manualMode && Array.from({ length: Math.max(0, manualSize - queue.length) }).map((_, index) => (
                <Button key={`slot-${index}`} variant="ghost" onClick={() => setShowManual(true)}
                  className="h-auto w-full justify-start rounded-none border-dashed px-3 py-2 text-left text-muted-foreground">
                  <span className="w-5 shrink-0 font-mono text-[10px]">{queue.length + index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium">Empty row — add a lead</span>
                    <span className="block text-[10px] font-normal">Fill it whenever you are ready. Work does not wait.</span>
                  </span>
                  <PlusCircle className="h-3.5 w-3.5" />
                </Button>
              ))}
            </div>
          </section>

          <main className="min-h-0 overflow-y-auto p-2">
            {selectedState && selectedResult ? (
              <div className="space-y-2">
                {/* ── Above-The-Fold Execution & Status Header ─────────── */}
                <div className="rounded-lg border bg-card p-3 space-y-2 shadow-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-bold truncate">
                          {nameOf.get(selectedState.ulid)?.name ?? selectedState.ulid}
                        </h2>
                        <DraftChip code={selectedState.crmDraft} />
                        {completedUlids.includes(selectedState.ulid) && (
                          <Badge variant="outline" className="border-success/60 text-success text-[10px] gap-1 bg-success/10 font-semibold">
                            <CheckCircle2 className="h-3 w-3" /> Worked Today
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {selectedState.phone || "No phone"} · {nameOf.get(selectedState.ulid)?.area || "Area not set"} · {selectedState.waAccount}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs font-semibold gap-1 hover:bg-primary/10"
                        onClick={advanceToNextCustomer}
                      >
                        Advance to Next <ArrowRight className="h-3.5 w-3.5" />
                        <span className="text-[10px] text-muted-foreground font-mono">↵ Enter</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[10px] text-muted-foreground"
                        title="Simulate past deadline to test overdue indicator"
                        onClick={triggerOverdueTest}
                      >
                        Test Overdue
                      </Button>
                    </div>
                  </div>

                  {/* ── Critical Status Strip: Owner, Next Action, Deadline & Real-Time OVERDUE ── */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="rounded border bg-muted/20 p-2">
                      <p className="text-[10px] font-semibold uppercase text-muted-foreground">Owner</p>
                      <p className="font-semibold text-foreground truncate mt-0.5">
                        👤 {selectedState.primaryOwnerName || mv.actor.name}
                      </p>
                    </div>
                    <div className="rounded border bg-muted/20 p-2">
                      <p className="text-[10px] font-semibold uppercase text-muted-foreground">Next Action</p>
                      <p className="font-semibold text-foreground truncate mt-0.5">
                        ⚡ {selectedState.nextAction ? (NEXT_ACTION_LABEL[selectedState.nextAction.kind] ?? selectedState.nextAction.kind) : "Action Required"}
                      </p>
                    </div>
                    <div className={cn("rounded border p-2", Boolean(selectedState.nextAction?.dueAt && new Date(selectedState.nextAction.dueAt).getTime() < Date.now()) ? "border-destructive/60 bg-destructive/10" : "bg-muted/20")}>
                      <p className="text-[10px] font-semibold uppercase text-muted-foreground">Deadline</p>
                      <p className={cn("font-semibold truncate mt-0.5 tabular-nums", Boolean(selectedState.nextAction?.dueAt && new Date(selectedState.nextAction.dueAt).getTime() < Date.now()) ? "text-destructive font-black" : "text-foreground")}>
                        ⏰ {selectedState.nextAction?.dueAt ? new Date(selectedState.nextAction.dueAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "Set on Outcome"}
                      </p>
                    </div>
                    <div className={cn("rounded border p-2 flex items-center justify-center", Boolean(selectedState.nextAction?.dueAt && new Date(selectedState.nextAction.dueAt).getTime() < Date.now()) ? "border-destructive bg-destructive/15 text-destructive" : "bg-muted/20 text-muted-foreground")}>
                      {Boolean(selectedState.nextAction?.dueAt && new Date(selectedState.nextAction.dueAt).getTime() < Date.now()) ? (
                        <Badge variant="destructive" className="animate-pulse bg-red-600 text-white font-black text-xs py-1 px-2.5 shadow-sm">
                          <AlertTriangle className="mr-1 h-3.5 w-3.5" /> 🔴 OVERDUE
                        </Badge>
                      ) : (
                        <span className="text-[11px] font-medium text-success flex items-center gap-1">
                          <Check className="h-3.5 w-3.5" /> Within SLA
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* ── ONE-TAP OUTCOME ACTION BAR ─────────────────────── */}
                <div className="rounded-lg border-2 border-amber-500/50 bg-amber-500/5 p-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="flex items-center gap-1.5 text-xs font-bold text-amber-800 dark:text-amber-300">
                      <Sparkles className="h-4 w-4 text-amber-600" />
                      ⚡ ONE-TAP OUTCOMES (1 Click = Result + Owner + Deadline + WhatsApp Message + Backend Save):
                    </span>
                    <span className="text-[10px] text-muted-foreground font-medium">Click to execute & auto-copy update:</span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isSavingOutcome}
                      className="h-auto py-2 px-2 text-left justify-start border-amber-500/50 hover:bg-amber-500/15 hover:border-amber-600 transition"
                      onClick={() => handleOneTapOutcome("tour")}
                    >
                      <div>
                        <div className="text-xs font-bold text-amber-900 dark:text-amber-200">🔥 Tour Booked</div>
                        <div className="text-[10px] text-muted-foreground">Tomorrow 11 AM</div>
                      </div>
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      disabled={isSavingOutcome}
                      className="h-auto py-2 px-2 text-left justify-start border-amber-500/50 hover:bg-amber-500/15 hover:border-amber-600 transition"
                      onClick={() => handleOneTapOutcome("options")}
                    >
                      <div>
                        <div className="text-xs font-bold text-amber-900 dark:text-amber-200">✅ Options Sent</div>
                        <div className="text-[10px] text-muted-foreground">Follow-up in 2h</div>
                      </div>
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      disabled={isSavingOutcome}
                      className="h-auto py-2 px-2 text-left justify-start border-amber-500/50 hover:bg-amber-500/15 hover:border-amber-600 transition"
                      onClick={() => handleOneTapOutcome("call")}
                    >
                      <div>
                        <div className="text-xs font-bold text-amber-900 dark:text-amber-200">📞 Connected</div>
                        <div className="text-[10px] text-muted-foreground">Call back in 2h</div>
                      </div>
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      disabled={isSavingOutcome}
                      className="h-auto py-2 px-2 text-left justify-start border-amber-500/50 hover:bg-amber-500/15 hover:border-amber-600 transition"
                      onClick={() => handleOneTapOutcome("quote")}
                    >
                      <div>
                        <div className="text-xs font-bold text-amber-900 dark:text-amber-200">🤝 Quote Sent</div>
                        <div className="text-[10px] text-muted-foreground">Token in 1h</div>
                      </div>
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      disabled={isSavingOutcome}
                      className="h-auto py-2 px-2 text-left justify-start border-amber-500/50 hover:bg-amber-500/15 hover:border-amber-600 transition"
                      onClick={() => handleOneTapOutcome("cold")}
                    >
                      <div>
                        <div className="text-xs font-bold text-amber-900 dark:text-amber-200">❄️ Cold / Exit</div>
                        <div className="text-[10px] text-muted-foreground">Nurture later</div>
                      </div>
                    </Button>
                  </div>
                </div>

                {/* ── AUTO-GENERATED OUTPUT PREVIEW & QUICK COPY ────── */}
                {lastGeneratedCustomerMsg && (
                  <div className="rounded-lg border border-success/40 bg-success/5 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-success">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>Auto-Generated WhatsApp Output (Copied to Clipboard)</span>
                      </div>
                      <Badge variant="outline" className="text-[9px] border-success/40 text-success">
                        ✓ Persisted to Supabase & Audit Log
                      </Badge>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="rounded border bg-background p-2">
                        <div className="flex items-center justify-between text-[10px] font-semibold text-muted-foreground uppercase mb-1">
                          <span>Customer WhatsApp Message</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 px-1.5 text-[9px] gap-1"
                            onClick={() => {
                              void navigator.clipboard.writeText(lastGeneratedCustomerMsg);
                              toast.success("Customer message copied!");
                            }}
                          >
                            <ClipboardCopy className="h-2.5 w-2.5" /> Copy
                          </Button>
                        </div>
                        <p className="text-xs whitespace-pre-wrap leading-relaxed font-sans">{lastGeneratedCustomerMsg}</p>
                      </div>

                      {lastGeneratedWrapUp && (
                        <div className="rounded border bg-background p-2">
                          <div className="flex items-center justify-between text-[10px] font-semibold text-muted-foreground uppercase mb-1">
                            <span>Internal Team Wrap-Up</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-5 px-1.5 text-[9px] gap-1"
                              onClick={() => {
                                void navigator.clipboard.writeText(lastGeneratedWrapUp);
                                toast.success("Team wrap-up copied!");
                              }}
                            >
                              <ClipboardCopy className="h-2.5 w-2.5" /> Copy
                            </Button>
                          </div>
                          <p className="text-xs whitespace-pre-wrap leading-relaxed font-mono text-[11px]">{lastGeneratedWrapUp}</p>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <span className="text-[10px] text-muted-foreground">Ready to message the lead and move on:</span>
                      <Button
                        size="sm"
                        className="h-7 text-xs font-semibold gap-1 bg-primary text-primary-foreground"
                        onClick={advanceToNextCustomer}
                      >
                        Advance to Next Customer <ArrowRight className="h-3 w-3" />
                        <span className="text-[10px] font-mono opacity-80">(↵ Enter)</span>
                      </Button>
                    </div>
                  </div>
                )}

                <div className="border bg-card p-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-semibold uppercase text-muted-foreground">Result contract</p>
                      <h2 className="truncate text-base font-semibold">{nameOf.get(selectedState.ulid)?.name ?? selectedState.ulid}</h2>
                      <p className="text-xs text-muted-foreground">{selectedState.lastCustomerMsg ?? "Latest WhatsApp message is waiting to be captured."}</p>
                    </div>
                    <Button size="sm" onClick={acceptDraft}><CheckCircle2 className="h-3.5 w-3.5" /> Draft done · write wrap-up</Button>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    <ContractCell label="Expected result" value={stage.outcome} />
                    <ContractCell label="Accountable owner" value={selectedState.primaryOwnerName || mv.actor.name} good={Boolean(selectedState.primaryOwnerId)} />
                    <ContractCell label="Deadline" value={selectedState.nextAction ? new Date(selectedState.nextAction.dueAt).toLocaleString() : "Set when draft is accepted"} good={Boolean(selectedState.nextAction)} />
                    <ContractCell label="Proof required" value={stage.proof} />
                    <ContractCell label="Receiver" value={stage.receiver} />
                    <ContractCell label="Acceptance" value={selectedResult.accepted ? "Accepted" : "Not accepted yet"} good={selectedResult.accepted} />
                  </div>
                  {selectedResult.missing.length > 0 && (
                    <div className="mt-2 flex items-center gap-1.5 border-l-2 border-destructive bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                      <AlertTriangle className="h-3.5 w-3.5" /> Not under control: add {selectedResult.missing.join(", ")}.
                    </div>
                  )}
                  <div className="mt-2 border-t pt-2">
                    <p className="text-[10px] font-semibold uppercase text-muted-foreground">How this result is produced</p>
                    <ol className="mt-1 grid gap-0.5 sm:grid-cols-2">
                      {stage.steps.map((step, index) => (
                        <li key={step} className="flex gap-1.5 text-[11px] leading-snug">
                          <span className="font-mono text-[10px] text-muted-foreground">{index + 1}.</span>{step}
                        </li>
                      ))}
                    </ol>
                    <p className="mt-1 text-[10px] text-destructive">Does not count: {stage.doesNotCount}</p>
                  </div>
                </div>
                <div className="border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <PhoneCall className="h-3.5 w-3.5 text-primary" />
                    <p className="text-[10px] font-semibold uppercase text-muted-foreground">Connected call — the result only counts when the customer talks</p>
                    <span className="ml-auto text-[10px] text-muted-foreground">Today {calls.connected} connected of {calls.dialled} dialled · {calls.rate}%</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button size="sm" onClick={dial}><Phone className="h-3.5 w-3.5" /> Start call {selectedState.phone ? `· ${selectedState.phone}` : ""}</Button>
                    <Button size="sm" variant="outline" className="border-success/50 text-success" onClick={() => endCall("connected")}><CheckCircle2 className="h-3.5 w-3.5" /> Connected</Button>
                    {(["no-answer", "busy", "rejected", "wrong-number"] as CallResult[]).map((result) => (
                      <Button key={result} size="sm" variant="outline" onClick={() => endCall(result)}>
                        <PhoneOff className="h-3.5 w-3.5" /> {result.replace("-", " ")}
                      </Button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[10px] text-muted-foreground">
                    Work state: {selectedState.work} · last outbound {selectedState.lastOutboundAt ? new Date(selectedState.lastOutboundAt).toLocaleTimeString() : "none today"}
                  </p>
                </div>

                <div className="border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Building2 className="h-3.5 w-3.5 text-primary" />
                    <p className="text-[10px] font-semibold uppercase text-muted-foreground">Property I am aiming to close for this customer</p>
                    <span className="ml-auto text-[10px] font-medium">{selectedState.tourProperty ?? "No property locked yet"}</span>
                  </div>
                  <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {rankedForCustomer(selectedState, aimed).slice(0, 6).map((option) => (
                      <Button key={option.id} variant="outline" onClick={() => aimProperty(option.id)}
                        className={cn("h-auto justify-start whitespace-normal p-2 text-left", selectedState.tourProperty === option.name && "border-primary bg-primary/10")}>
                        <span>
                          <span className="block text-[11px] font-semibold">{option.name}</span>
                          <span className="block text-[10px] font-normal text-muted-foreground">
                            {option.area} · {option.bedsFree} beds free · from ₹{option.fromPrice.toLocaleString("en-IN")}
                          </span>
                          {aimed.includes(option.id) && <span className="mt-0.5 block text-[9px] font-semibold text-primary">On today’s closing list</span>}
                        </span>
                      </Button>
                    ))}
                  </div>
                </div>

                {debriefFor?.ulid === selectedState.ulid && (
                  <DebriefCard code={debriefFor.code} customer={nameOf.get(selectedState.ulid)?.name ?? selectedState.ulid}
                    onSave={finishDebrief} onCopy={copyMessage} onPreview={previewMessage} onClose={() => setDebriefFor(null)} />
                )}

                <WorkPanel ulid={selected} meta={nameOf} />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Choose a customer to own a result.</div>
            )}
          </main>

          <aside className="min-h-0 overflow-y-auto border-l bg-card p-2">
            <RoundCloseSummaryCard
              commitment={commitment}
              actual={actual}
              queue={queue}
              list={list}
              actorName={mv.actor.name}
              role={activeRole}
              goal={activeGoal}
            />

            <div className="mt-2">
              <CheckpointPanel role={activeRole} operatorId={mv.actor.id} operatorName={mv.actor.name}
                states={list} events={events} onOpenCustomer={setSelected} />
            </div>

            <div className="mt-2"><ProgressReporter round={round} onRound={setRound} actual={actual} committed={commitment.commitCount}
              moved={moved} stuck={stuck} need={need} onMoved={setMoved} onStuck={setStuck} onNeed={setNeed} onSave={saveReport} />
            </div>

            {weakRounds >= 2 && (
              <div className="mt-2 border border-destructive/40 bg-destructive/10 p-2 text-xs">
                <p className="font-semibold text-destructive">Manager support required now</p>
                <p className="mt-0.5 text-muted-foreground">Two rounds are weak. Remove or re-route one blocker before continuing.</p>
              </div>
            )}

            <div className="mt-2 border p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase text-muted-foreground">Today’s promise</p>
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[9px]" onClick={clearCommitment}>Reset</Button>
              </div>
              <p className="mt-1 text-xs font-semibold">I will deliver {commitment.commitCount} {stage.unit} today.</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{stage.outcome}</p>
              {commitment.supportNeeded && <p className="mt-1 text-[10px]"><strong>Support:</strong> {commitment.supportNeeded}</p>}
            </div>

            <div className="mt-2 border p-2">
              <div className="flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5 text-primary" /><p className="text-[10px] font-semibold uppercase text-muted-foreground">Properties I am closing today</p></div>
              {aimProgress.length === 0 ? (
                <p className="mt-1 text-[10px] text-muted-foreground">No property picked for today. Choose one on any customer to start the closing list.</p>
              ) : (
                <div className="mt-1.5 space-y-1.5">
                  {aimProgress.map((row) => (
                    <div key={row.id} className="border px-2 py-1.5">
                      <p className="text-[11px] font-semibold">{row.name}</p>
                      <p className="text-[9px] text-muted-foreground">{row.area} · {row.bedsFree} beds free</p>
                      <p className="mt-0.5 text-[10px]">Aimed {row.aimed} · tours {row.toursSet} · done {row.toursDone} · booked <strong className={cn(row.booked > 0 && "text-success")}>{row.booked}</strong></p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-2 border p-2">
              <div className="flex items-center gap-1.5"><MessageCircle className="h-3.5 w-3.5 text-primary" /><p className="text-[10px] font-semibold uppercase text-muted-foreground">Wrap-ups sent today</p></div>
              {todaysDebriefs.length === 0 ? (
                <p className="mt-1 text-[10px] text-muted-foreground">After each draft, write the wrap-up and paste it in the team group.</p>
              ) : (
                <div className="mt-1.5 space-y-1.5">
                  {todaysDebriefs.slice(0, 6).map((item) => (
                    <div key={item.id} className="border px-2 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-[11px] font-semibold">{item.draftCode} · {item.customerName}</p>
                        <Button size="sm" variant="ghost" className="h-6 px-1 text-[9px]" onClick={() => copyMessage(item.id, item.message)}>
                          <ClipboardCopy className="h-3 w-3" /> Copy
                        </Button>
                      </div>
                      <p className="text-[9px] text-muted-foreground">{item.sentOnWhatsapp ? "Copied for WhatsApp" : "Not sent yet"} · {new Date(item.createdAt).toLocaleTimeString()}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-2"><JourneyTimeline ulid={selected} /></div>
          </aside>
        </div>
      )}

      <ManualDraftPanel open={showManual} onClose={() => setShowManual(false)} candidates={candidates}
        manualList={manualList} manualMode={manualMode} manualSize={manualSize}
        onManualMode={setManualMode} onManualSize={setManualSize} onAdd={addToManual}
        onRemove={removeFromManual} onReplace={replaceInManual} onClear={clearManual}
        onCreateLead={createManualLead} onFillDemo={fillManualDemo} onStartEmpty={startEmptyDraft} runningFor={elapsed} />

      {showFormat && (
        <FormatDrawer onClose={() => setShowFormat(false)}
          sample={previewMessage({
            done: "Called, qualified, shared 2 properties",
            wentWell: "Customer picked Saturday 11 AM",
            wentBadly: "Budget ₹1,000 below our price",
            problems: "Need inventory truth for Sobha Dream Acres",
          }) || sampleMessage()} />
      )}

      {showPlaybook && <PlaybookDrawer playbook={playbook} onClose={() => setShowPlaybook(false)} />}
    </div>
  );
}

function CommitmentGate({ role, goal, commitCount, support, aimProperties, onAimProperties, query, onQuery, onRole, onGoal, onCommitCount, onSupport, onStart }: {
  role: CareRole; goal: CareGoal; commitCount: number; support: string;
  aimProperties: string[]; onAimProperties: (ids: string[]) => void;
  query: string; onQuery: (value: string) => void;
  onRole: (role: CareRole) => void; onGoal: (goal: CareGoal) => void;
  onCommitCount: (value: number) => void; onSupport: (support: string) => void; onStart: () => void;
}) {
  const toggleProperty = (id: string) =>
    onAimProperties(aimProperties.includes(id) ? aimProperties.filter((item) => item !== id) : [...aimProperties, id]);
  const shown = propertyOptions.filter((option) =>
    `${option.name} ${option.area}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 12);
  const playbook = CARE_PLAYBOOKS[role];
  const active = playbook.stages.find((item) => item.goal === goal) ?? playbook.stages[0];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mx-auto max-w-5xl border bg-card">
        <div className="border-b px-4 py-3">
          <div className="flex items-center gap-2"><Flag className="h-4 w-4 text-primary" /><h2 className="text-base font-semibold">Set today’s expected result before drafting</h2></div>
          <p className="mt-1 text-xs text-muted-foreground">“This is my expectation from today. This is what I will achieve.” Calls and messages are work; the selected result is the commitment.</p>
        </div>
        <div className="grid gap-4 p-4 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">I am working today as</p>
              <div className="flex gap-2">
                {(["flow-ops", "tcm"] as CareRole[]).map((item) => (
                  <Button key={item} variant={role === item ? "default" : "outline"} onClick={() => onRole(item)}>{CARE_PLAYBOOKS[item].label}</Button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">The result I will aim for</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {playbook.stages.map((item) => (
                  <Button key={item.goal} variant="outline" onClick={() => onGoal(item.goal)}
                    className={cn("h-auto min-h-20 justify-start whitespace-normal p-3 text-left", goal === item.goal && GOAL_TONE[item.goal])}>
                    <span>
                      <span className="block text-xs font-bold">{GOAL_TITLE[item.goal]}</span>
                      <span className="mt-1 block text-[10px] font-normal">{item.outcome}</span>
                      <span className="mt-1 block text-[10px] font-semibold">Usual day: {item.dayCount} {item.unit}</span>
                    </span>
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
              <label className="text-xs font-medium">How many {active.unit} today<Input type="number" min={1} value={commitCount} onChange={(event) => onCommitCount(Number(event.target.value) || 1)} className="mt-1" /></label>
              <label className="text-xs font-medium">Support needed today<Input value={support} onChange={(event) => onSupport(event.target.value)} placeholder="Inventory check, manager help, pricing approval…" className="mt-1" /></label>
            </div>
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <p className="text-[10px] font-semibold uppercase text-muted-foreground">Properties I am aiming to close</p>
                <span className="text-[10px] text-muted-foreground">{aimProperties.length} selected</span>
                <Input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search property or area" className="ml-auto h-8 w-48 text-xs" />
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {shown.map((option) => (
                  <Button key={option.id} variant="outline" onClick={() => toggleProperty(option.id)}
                    className={cn("h-auto justify-start whitespace-normal p-2 text-left", aimProperties.includes(option.id) && "border-primary bg-primary/10")}>
                    <span>
                      <span className="block text-[11px] font-semibold">{option.name}</span>
                      <span className="block text-[10px] font-normal text-muted-foreground">{option.area} · {option.bedsFree} beds free · from ₹{option.fromPrice.toLocaleString("en-IN")}</span>
                    </span>
                  </Button>
                ))}
              </div>
            </div>
            <Button onClick={onStart} className="w-full sm:w-auto"><Flag className="h-4 w-4" /> Commit this result and open drafts</Button>
          </div>
          <div className="border bg-muted/30 p-3">
            <p className="text-[10px] font-semibold uppercase text-muted-foreground">Your contract</p>
            <p className="mt-2 text-sm font-semibold">I will deliver {commitCount} {active.unit} today.</p>
            <p className="mt-2 text-xs text-muted-foreground">{active.outcome}</p>
            <ol className="mt-3 space-y-1 text-[11px]">
              {active.steps.map((step, index) => (
                <li key={step} className="flex gap-1.5"><span className="font-mono text-muted-foreground">{index + 1}.</span>{step}</li>
              ))}
            </ol>
            <dl className="mt-3 space-y-2 text-xs">
              <div><dt className="text-muted-foreground">Proof</dt><dd>{active.proof}</dd></div>
              <div><dt className="text-muted-foreground">Does not count</dt><dd className="text-destructive">{active.doesNotCount}</dd></div>
              <div><dt className="text-muted-foreground">Accepted by</dt><dd>{active.receiver}</dd></div>
              <div><dt className="text-muted-foreground">Required when</dt><dd>{active.requireWhen}</dd></div>
              <div><dt className="text-muted-foreground">Closing these properties</dt><dd>{aimProperties.length ? aimProperties.map((id) => propertyOptions.find((option) => option.id === id)?.name).join(", ") : "Not chosen yet"}</dd></div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProgressReporter({ round, onRound, actual, committed, moved, stuck, need, onMoved, onStuck, onNeed, onSave }: {
  round: CareRound; onRound: (round: CareRound) => void; actual: number; committed: number;
  moved: string; stuck: string; need: string; onMoved: (value: string) => void;
  onStuck: (value: string) => void; onNeed: (value: string) => void; onSave: () => void;
}) {
  return (
    <div className="border p-2">
      <div className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5 text-primary" /><p className="text-[10px] font-semibold uppercase text-muted-foreground">Periodic progress</p></div>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {(Object.keys(ROUND_COPY) as CareRound[]).map((item) => (
          <Button key={item} size="sm" variant={round === item ? "default" : "outline"} className="h-7 px-1 text-[9px]" onClick={() => onRound(item)}>{ROUND_COPY[item].label}</Button>
        ))}
      </div>
      <p className="mt-2 text-xs font-semibold">{ROUND_COPY[round].question}</p>
      <div className="mt-2 flex items-center justify-between text-[10px]"><span>Counted by the system</span><strong>{actual}/{committed}</strong></div>
      <Progress value={Math.min(100, Math.round((actual / Math.max(committed, 1)) * 100))} className="mt-1" />
      <div className="mt-2 space-y-1.5">
        <Textarea value={moved} onChange={(event) => onMoved(event.target.value)} placeholder="Moved — what result changed?" className="min-h-14 text-xs" />
        <Textarea value={stuck} onChange={(event) => onStuck(event.target.value)} placeholder="Stuck — what is blocking the result?" className="min-h-14 text-xs" />
        <Input value={need} onChange={(event) => onNeed(event.target.value)} placeholder="Need — who should help with what?" className="h-8 text-xs" />
      </div>
      <Button size="sm" className="mt-2 w-full" onClick={onSave}>Report progress</Button>
      <p className="mt-1 text-[9px] text-muted-foreground">{ROUND_COPY[round].accepted}</p>
    </div>
  );
}

function PlaybookDrawer({ playbook, onClose }: { playbook: (typeof CARE_PLAYBOOKS)[CareRole]; onClose: () => void }) {
  return (
    <div className="absolute inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l bg-card shadow-xl">
      <div className="sticky top-0 flex items-center justify-between border-b bg-card px-4 py-3">
        <div><p className="text-[10px] uppercase text-muted-foreground">CARE V5 playbook</p><h2 className="font-semibold">{playbook.label}</h2></div>
        <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
      </div>
      <div className="space-y-3 p-4">
        <div className="border p-3"><p className="text-[10px] font-semibold uppercase text-muted-foreground">Role promise</p><p className="mt-1 text-sm">{playbook.promise}</p></div>
        {playbook.stages.map((item) => (
          <div key={item.goal} className="border p-3">
            <div className="flex items-center justify-between gap-2">
              <Badge className={cn("border", GOAL_TONE[item.goal])}>{item.goal}</Badge>
              <span className="text-xs font-semibold">A usual day: {item.dayCount} {item.unit}</span>
            </div>
            <p className="mt-2 text-sm font-semibold">{GOAL_TITLE[item.goal]}</p>
            <p className="mt-1 text-xs text-muted-foreground">{item.outcome}</p>
            <p className="mt-2 text-[10px] font-semibold uppercase text-muted-foreground">Step by step</p>
            <ol className="mt-1 space-y-1 text-xs">
              {item.steps.map((step, index) => (
                <li key={step} className="flex gap-1.5"><span className="font-mono text-muted-foreground">{index + 1}.</span>{step}</li>
              ))}
            </ol>
            <div className="mt-2 grid gap-1.5 text-xs">
              <p><strong>It counts when:</strong> {item.proof}</p>
              <p className="text-destructive"><strong>It does not count when:</strong> {item.doesNotCount}</p>
              <p><strong>Handed to:</strong> {item.receiver}</p>
              <p><strong>Choose this day when:</strong> {item.recommendWhen}</p>
              <p><strong>You must choose it when:</strong> {item.requireWhen}</p>
            </div>
          </div>
        ))}
        <div className="border p-3"><p className="text-[10px] font-semibold uppercase text-muted-foreground">Acceptance gate</p><p className="mt-1 text-xs">{playbook.acceptanceGate}</p></div>
        <div className="border p-3"><p className="text-[10px] font-semibold uppercase text-muted-foreground">Non-negotiable safeguards</p>{playbook.safeguards.map((item) => <p key={item} className="mt-2 flex gap-2 text-xs"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />{item}</p>)}</div>
      </div>
    </div>
  );
}

function DebriefCard({ code, customer, onSave, onCopy, onPreview, onClose }: {
  code: string; customer: string;
  onPreview: (input: { done: string; wentWell: string; wentBadly: string; problems: string }) => string;
  onSave: (input: { done: string; wentWell: string; wentBadly: string; problems: string }) => { id: string; message: string } | undefined;
  onCopy: (id: string, message: string) => void;
  onClose: () => void;
}) {
  const [done, setDone] = useState("");
  const [wentWell, setWentWell] = useState("");
  const [wentBadly, setWentBadly] = useState("");
  const [problems, setProblems] = useState("");
  const [saved, setSaved] = useState<{ id: string; message: string } | null>(null);

  const build = () => {
    const result = onSave({ done, wentWell, wentBadly, problems });
    if (result) setSaved({ id: result.id, message: result.message });
  };

  return (
    <div className="border-2 border-primary bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <MessageCircle className="h-4 w-4 text-primary" />
        <p className="text-xs font-semibold">{code} is done for {customer} — wrap it up before you move on</p>
        <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[10px]" onClick={onClose}>Close</Button>
      </div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        <label className="text-[10px] font-semibold uppercase text-muted-foreground">What is done?
          <Textarea value={done} onChange={(event) => setDone(event.target.value)} placeholder="Called, qualified, shared 2 properties…" className="mt-1 min-h-14 text-xs" />
        </label>
        <label className="text-[10px] font-semibold uppercase text-muted-foreground">What went well?
          <Textarea value={wentWell} onChange={(event) => setWentWell(event.target.value)} placeholder="Customer picked a date straight away…" className="mt-1 min-h-14 text-xs" />
        </label>
        <label className="text-[10px] font-semibold uppercase text-muted-foreground">What went badly?
          <Textarea value={wentBadly} onChange={(event) => setWentBadly(event.target.value)} placeholder="Budget below our price, went cold on rent…" className="mt-1 min-h-14 text-xs" />
        </label>
        <label className="text-[10px] font-semibold uppercase text-muted-foreground">Any other problem or help needed?
          <Textarea value={problems} onChange={(event) => setProblems(event.target.value)} placeholder="Need inventory truth for Salarpuria, need pricing approval…" className="mt-1 min-h-14 text-xs" />
        </label>
      </div>
      <div className="mt-2 border bg-muted/30 p-2">
        <p className="text-[10px] font-semibold uppercase text-muted-foreground">WhatsApp message being written — live</p>
        <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-snug">{onPreview({ done, wentWell, wentBadly, problems })}</pre>
      </div>
      <Button size="sm" className="mt-2" onClick={build}><CheckCircle2 className="h-3.5 w-3.5" /> Make the WhatsApp update</Button>
      {saved && (
        <div className="mt-2 border bg-muted/30 p-2">
          <p className="text-[10px] font-semibold uppercase text-muted-foreground">Copy this and paste it in the team WhatsApp group</p>
          <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-snug">{saved.message}</pre>
          <Button size="sm" className="mt-2" onClick={() => onCopy(saved.id, saved.message)}>
            <ClipboardCopy className="h-3.5 w-3.5" /> Copy for WhatsApp
          </Button>
        </div>
      )}
    </div>
  );
}

const SAMPLE_INPUT = {
  done: "Called, qualified, shared 2 properties",
  wentWell: "Customer picked Saturday 11 AM",
  wentBadly: "Budget ₹1,000 below our price",
  problems: "Need inventory truth for Sobha Dream Acres",
};

/** Used only when no customer is open, so the format is always visible. */
function sampleMessage() {
  return debriefMessage({
    ...SAMPLE_INPUT,
    customerName: "Kavya Reddy",
    draftCode: "D1",
    goal: "FIND",
    operatorName: "You",
    resultNow: 12,
    commitCount: 40,
    property: "Embassy Springs",
    nextStep: "Call back",
    dueAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
  });
}

function FormatDrawer({ sample, onClose }: { sample: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-background/70 backdrop-blur-sm">
      <div className="flex h-full w-full max-w-lg flex-col border-l bg-card shadow-xl">
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <MessageCircle className="h-4 w-4 text-primary" />
          <div>
            <p className="text-sm font-semibold">WhatsApp update — how it is written</p>
            <p className="text-[10px] text-muted-foreground">This exact message is built after every draft is done.</p>
          </div>
          <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-[10px]" onClick={onClose}>Close</Button>
        </header>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          <div className="border bg-muted/30 p-2">
            <p className="text-[10px] font-semibold uppercase text-muted-foreground">The shape of every message</p>
            <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-snug">{`*<draft code> update · <customer name>*
<your name> · <time> · <result you chose>

✅ Done: <what you did>
👍 Went well: <what worked>
👎 Went badly: <what did not work>
⚠️ Problem / help needed: <what you need>
🏠 Property in play: <property, if locked>
➡️ Next step: <next action> by <time>

📊 My day so far: <done>/<promised> results`}</pre>
          </div>
          <div className="border p-2">
            <p className="text-[10px] font-semibold uppercase text-muted-foreground">Live example with your numbers</p>
            <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-snug">{sample}</pre>
            <Button size="sm" className="mt-2 h-7 text-[10px]" onClick={() => navigator.clipboard?.writeText(sample)}>
              <ClipboardCopy className="h-3 w-3" /> Copy this example
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Property and next step appear only when they exist on the customer. Nothing else is added automatically.
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return <div className="min-w-[70px] rounded-md border bg-background px-2 py-1"><p className="text-[9px] text-muted-foreground">{label}</p><p className={cn("text-sm font-semibold", danger && "text-destructive")}>{value}</p></div>;
}

function ContractCell({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div className="min-h-14 border px-2 py-1.5"><p className="text-[9px] font-semibold uppercase text-muted-foreground">{label}</p><p className={cn("mt-0.5 text-[11px] leading-snug", good === true && "text-success", good === false && "text-destructive")}>{value}</p></div>;
}

function RoundCloseSummaryCard({
  commitment,
  actual,
  queue,
  list,
  actorName,
  role,
  goal,
}: {
  commitment: DailyCommitment | null;
  actual: number;
  queue: Array<{ ulid: string; state: any; bucket: string }>;
  list: any[];
  actorName: string;
  role: CareRole;
  goal: CareGoal;
}) {
  const committed = commitment?.commitCount ?? 0;
  const completed = actual;
  const pending = Math.max(0, queue.length - actual);
  const overdue = list.filter((item) => Boolean(item.nextAction?.dueAt && new Date(item.nextAction.dueAt).getTime() < Date.now())).length;
  const escalated = list.filter((item) => item.bucket === "P0" || item.blocker !== "none" || (item.customerWaitingSince && Date.now() - new Date(item.customerWaitingSince).getTime() > 24 * 3600_000)).length;

  const copyWhatsAppSummary = async () => {
    const time = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    const today = new Date().toISOString().slice(0, 10);
    const pct = committed > 0 ? Math.round((completed / committed) * 100) : 0;
    const msg = [
      `*DAILY CARE ROUND UPDATE — Gharpayy Movement OS*`,
      `👤 Operator: ${actorName} | Role: ${role} | Goal: ${goal}`,
      `📅 Date: ${today} · ${time}`,
      ``,
      `📊 *Metrics:*`,
      `• Committed: ${committed}`,
      `• Completed: ${completed} (${pct}%)`,
      `• Pending: ${pending}`,
      `• Overdue: ${overdue} ${overdue > 0 ? "🔴" : "✅"}`,
      `• Escalated: ${escalated} ${escalated > 0 ? "⚠️" : "✅"}`,
      ``,
      `Status: ${completed >= committed ? "✅ ON TRACK" : "⚠️ PACE REQUIRED"}`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(msg);
      toast.success("Round closing summary copied to clipboard!");
    } catch {
      toast.error("Could not copy round summary.");
    }
  };

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
          <Clock3 className="h-4 w-4" />
          <span>Round Close & Daily Summary</span>
        </div>
        <Badge variant={completed >= committed ? "default" : "outline"} className="text-[10px]">
          {completed >= committed ? "Goal Reached" : `${completed}/${committed}`}
        </Badge>
      </div>

      <div className="grid grid-cols-5 gap-1 text-center">
        <div className="rounded border bg-background p-1">
          <p className="text-[8px] uppercase text-muted-foreground font-medium">Committed</p>
          <p className="text-xs font-bold text-foreground">{committed}</p>
        </div>
        <div className="rounded border bg-background p-1">
          <p className="text-[8px] uppercase text-muted-foreground font-medium">Completed</p>
          <p className="text-xs font-bold text-success">{completed}</p>
        </div>
        <div className="rounded border bg-background p-1">
          <p className="text-[8px] uppercase text-muted-foreground font-medium">Pending</p>
          <p className="text-xs font-bold text-foreground">{pending}</p>
        </div>
        <div className={cn("rounded border bg-background p-1", overdue > 0 && "border-destructive/50 bg-destructive/10")}>
          <p className="text-[8px] uppercase text-muted-foreground font-medium">Overdue</p>
          <p className={cn("text-xs font-bold", overdue > 0 ? "text-destructive font-black" : "text-muted-foreground")}>
            {overdue > 0 ? `🔴 ${overdue}` : "0"}
          </p>
        </div>
        <div className={cn("rounded border bg-background p-1", escalated > 0 && "border-amber-500/50 bg-amber-500/10")}>
          <p className="text-[8px] uppercase text-muted-foreground font-medium">Escalated</p>
          <p className={cn("text-xs font-bold", escalated > 0 ? "text-amber-600" : "text-muted-foreground")}>
            {escalated > 0 ? `⚠️ ${escalated}` : "0"}
          </p>
        </div>
      </div>

      <Button
        size="sm"
        className="w-full text-xs font-semibold gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
        onClick={copyWhatsAppSummary}
      >
        <ClipboardCopy className="h-3.5 w-3.5" />
        Copy WhatsApp Round Summary
      </Button>
    </div>
  );
}