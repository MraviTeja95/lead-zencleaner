import { saveExecutionState, appendTimeline } from "@/e2eplus/persistence";
import type { LeadExec, WhereOption } from "@/e2eplus/store";
import type { Situation } from "@/e2eplus/journey";
import { useAuditLog } from "@/lib/audit-log";
import { logAction } from "@/lib/monitoring/activity-store";
import { useIdentityStore } from "@/lib/lead-identity/store";
import { canonicalCustomerId } from "@/lib/canonical/customer-id";

export interface BookingPersistencePayload {
  leadId: string;
  leadName: string;
  phone?: string | null;
  actor: { id: string; name: string };
  outcomeCode: string;
  outcomeLabel: string;
  stage: string;
  situation: Situation;
  nextActionKind: string;
  nextActionNote: string;
  dueAt: string;
  ownerId: string;
  ownerName: string;
  customerMessage: string;
  internalWrapUp: string;
  property?: string | null;
  rent?: number | null;
  deposit?: number | null;
}

/**
 * Authoritative persistence for Booking Flow Split execution:
 * 1. Writes to Supabase e2e_lead_execution
 * 2. Appends to Supabase e2e_lead_timeline
 * 3. Logs to universal audit log (useAuditLog)
 * 4. Logs to monitoring activity store (logAction)
 * 5. Syncs to canonical lead-identity store
 */
export async function persistBookingAction(payload: BookingPersistencePayload): Promise<{ ok: boolean; error?: string }> {
  const {
    leadId,
    leadName,
    phone,
    actor,
    outcomeLabel,
    situation,
    nextActionKind,
    nextActionNote,
    dueAt,
    ownerId,
    ownerName,
    property,
  } = payload;

  const canonicalId = phone ? canonicalCustomerId({ phone, name: leadName }) : leadId;
  const targetId = canonicalId || leadId;

  // 1. Audit Log (universal audit entry)
  useAuditLog.getState().log({
    actorId: actor.id,
    actorName: actor.name,
    entityType: "lead",
    entityId: targetId,
    action: "booking-flow-outcome",
    summary: `${outcomeLabel} · Next: ${nextActionKind} by ${new Date(dueAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · Owner: ${ownerName}`,
    after: {
      outcome: outcomeLabel,
      owner: ownerName,
      deadline: dueAt,
      nextAction: nextActionKind,
      property: property ?? null,
      situation,
    },
  });

  // 2. Monitoring Action Log
  logAction({
    userId: actor.id,
    userName: actor.name,
    leadId: targetId,
    leadName,
    action: "booking-flow-outcome",
    feature: "booking-flow-split",
    stageTo: situation,
    remarks: `${outcomeLabel} | ${nextActionNote}`,
  });

  // 3. Identity store timeline sync
  try {
    const identityStore = useIdentityStore.getState();
    const existing = identityStore.leads.find((l) => l.ulid === targetId || l.ulid === leadId);
    if (existing) {
      identityStore.logActivity(
        existing.ulid,
        "state-changed",
        `[Booking Flow] ${outcomeLabel} (Owner: ${ownerName}, Next: ${nextActionKind} due ${new Date(dueAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })})`,
        { outcome: outcomeLabel, nextActionKind, dueAt, ownerName, property }
      );
    }
  } catch (err: unknown) {
    console.warn("Identity store timeline sync warning:", err);
  }

  // 4. Hosted Supabase backend sync (e2e_lead_execution + e2e_lead_timeline)
  try {
    const exec: LeadExec = {
      leadId: targetId,
      where: "Active WhatsApp Chat" as WhereOption,
      channel: "WhatsApp",
      when: "TODAY",
      followUpAt: dueAt,
      ownerId,
      ownerName,
      claimedAt: new Date().toISOString(),
      ownershipMode: "OWNED",
      urgency: "IMMEDIATE",
      probability: situation === "TOKEN PENDING" ? "HIGH" : situation === "TOUR SCHEDULED" ? "HIGH" : "MEDIUM",
      situation,
      nextAction: nextActionKind,
      nextActionAt: dueAt,
      lastOutcome: outcomeLabel,
      timeline: [],
    };

    await saveExecutionState(exec);
    await appendTimeline(
      targetId,
      actor.name || "Operator",
      `Booking Flow Split: ${outcomeLabel} (Next: ${nextActionKind} due ${new Date(dueAt).toLocaleTimeString("en-IN")})`
    );

    return { ok: true };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Supabase hosted backend sync error:", errorMsg);
    return { ok: false, error: errorMsg };
  }
}
