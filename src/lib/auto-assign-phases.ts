import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { extractJsonObject } from "./ai-json";

// AI phase (cost code) matching for estimate line items — shared by the manual
// "Auto-Assign Phases" button (/api/ai-estimate/assign-phases) and the automatic
// hook in autoAssignPhasesForEstimate below, which runs whenever an estimate is
// saved/approved so crew clock-in (which requires cost-coded items) isn't blocked
// on someone remembering to click the button.

export type PhaseAssignItemInput = { id: unknown; name: unknown; description?: unknown };
export type PhaseAssignCostCodeInput = { id: unknown; code: unknown; name: unknown };
export type PhaseAssignment = { id: string; costCodeId: string | null };

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

// Core AI matcher. Normalizes/caps inputs itself so any caller (a raw HTTP body
// or a DB read) is safe to pass through untrusted. Throws on AI/config failure —
// callers that must never fail (autoAssignPhasesForEstimate) catch and swallow;
// the route re-surfaces the message to the client.
export async function matchItemsToCostCodes(
  rawItems: PhaseAssignItemInput[],
  rawCostCodes: PhaseAssignCostCodeInput[],
): Promise<PhaseAssignment[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  // Normalize and cap every field that reaches the prompt — count caps alone
  // don't bound prompt size, and null/non-string entries must not throw.
  const safeItems = rawItems
    .filter((it) => !!it && typeof it === "object")
    .map((it) => ({ id: str(it.id, 100), name: str(it.name, 200), description: str(it.description, 500) }))
    .filter((it) => it.id)
    .slice(0, 500);
  const safeCostCodes = rawCostCodes
    .filter((cc) => !!cc && typeof cc === "object")
    .map((cc) => ({ id: str(cc.id, 100), code: str(cc.code, 50), name: str(cc.name, 100) }))
    .filter((cc) => cc.id)
    .slice(0, 200);

  if (safeItems.length === 0 || safeCostCodes.length === 0) return [];

  const itemsList = safeItems
    .map((item, i) =>
      `${i + 1}. ID: "${item.id}" | Name: "${item.name}"${item.description ? ` | Description: "${item.description}"` : ""}`)
    .join("\n");

  const codesList = safeCostCodes
    .map((cc) => `- Code: "${cc.code}" | Name: "${cc.name}" | ID: "${cc.id}"`)
    .join("\n");

  const prompt = `You are an expert construction estimator. Your job is to assign the best matching phase (cost code) to each estimate line item.

Available Phases:
${codesList}

Estimate Line Items to Assign:
${itemsList}

Rules:
- Select the best phase for each item based on its name and description.
- For example:
  - "Site Protection", "dust containment", "cleanup" -> 01-DEMO (Demolition) or 20-CLEAN (Cleanup & Disposal)
  - "studs", "framing", "joists", "wood" -> 02-FRAME (Framing)
  - "rough-in plumbing", "drain", "water line" -> 03-PLUMB (Plumbing)
  - "outlet", "switch", "wiring", "electrical panel" -> 04-ELEC (Electrical)
  - "HVAC", "exhaust fan", "ductwork" -> 05-HVAC (HVAC)
  - "insulation", "vapor barrier" -> 06-INSUL (Insulation)
  - "drywall", "taping", "sheetrock" -> 07-DRYWALL (Drywall)
  - "paint", "stain", "caulk" -> 08-PAINT (Paint & Finish)
  - "flooring", "lvp", "hardwood", "carpet" -> 09-FLOOR (Flooring)
  - "tile backsplash", "shower tile", "grout" -> 10-TILE (Tile Work)
  - "cabinet", "vanity", "pantry cabinet" -> 11-CABINET (Cabinetry)
  - "countertop", "quartz", "granite" -> 12-COUNTER (Countertops)
  - "trim", "millwork", "baseboard" -> 13-TRIM (Trim & Millwork)
  - "door", "window" -> 14-DOOR (Doors & Windows)
  - "roof", "roofing", "gutters" -> 15-ROOF (Roofing)
  - "siding", "housewrap" -> 16-SIDING (Siding & Exterior)
  - "concrete slab", "foundation", "footings" -> 17-CONCRETE (Concrete & Foundation)
  - "appliance", "range", "fridge", "dishwasher" -> 18-APPLIANCE (Appliances)
  - "sink", "faucet", "toilet", "bath accessories" -> 19-FIXTURE (Fixtures & Hardware)
- If a line item does not map to any specific category, assign it to the closest match or leave costCodeId as null.
- Return ONLY valid JSON in this exact shape. Do not include any conversational text or markdown blocks:
{
  "assignments": [
    {
      "id": "<exact id from input>",
      "costCodeId": "<the ID of the matched phase, or null if no match>"
    }
  ]
}`;

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const block = response.content[0];
  const rawText = ("text" in block ? block.text : "").trim();
  if (!rawText) {
    throw new Error("No response from AI");
  }

  const parsed = extractJsonObject<any>(rawText);
  if (!parsed) {
    throw new Error("Could not parse AI response");
  }

  // Only trust IDs that were actually submitted — the model (or an injected
  // item description) must not be able to introduce arbitrary ids.
  const validItemIds = new Set(safeItems.map((i) => i.id));
  const validCostCodeIds = new Set(safeCostCodes.map((c) => c.id));
  return (parsed.assignments || [])
    .map((a: any) => ({
      id: String(a.id ?? ""),
      costCodeId: a.costCodeId ? String(a.costCodeId) : null,
    }))
    .filter((a: { id: string }) => validItemIds.has(a.id))
    .map((a: { id: string; costCodeId: string | null }) => ({
      id: a.id,
      costCodeId: a.costCodeId && validCostCodeIds.has(a.costCodeId) ? a.costCodeId : null,
    }));
}

// Per-estimate in-flight guard so concurrent auto-assign calls for the same
// estimate (e.g. a quick edit-then-save firing the saveEstimate hook twice)
// dedupe to a single running job instead of racing each other. Best-effort
// per serverless instance only — it does not coordinate across instances,
// which is fine since the per-item conditional write below is itself race-safe.
const inFlight = new Map<string, Promise<void>>();
const rerunQueued = new Set<string>();

// Auto-codes any not-yet-coded items on an estimate. Idempotent (only ever
// touches items with costCodeId == null) and fail-soft (logs and returns on
// any AI/DB error — must never block the estimate save/approve it's hooked
// into). No-op when there's nothing uncoded or no active cost codes to match
// against.
export async function autoAssignPhasesForEstimate(estimateId: string): Promise<void> {
  const existing = inFlight.get(estimateId);
  if (existing) {
    // A newer save arrived mid-run — its items may differ from what the running
    // job read, so queue exactly one follow-up run instead of just sharing the
    // (potentially stale) in-flight result.
    rerunQueued.add(estimateId);
    return existing;
  }

  const run = runAutoAssignPhasesForEstimate(estimateId).finally(() => {
    inFlight.delete(estimateId);
    if (rerunQueued.delete(estimateId)) {
      void autoAssignPhasesForEstimate(estimateId);
    }
  });
  inFlight.set(estimateId, run);
  return run;
}

async function runAutoAssignPhasesForEstimate(estimateId: string): Promise<void> {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return;

    const [allItems, activeCostCodes] = await Promise.all([
      prisma.estimateItem.findMany({
        where: { estimateId },
        select: { id: true, parentId: true, name: true, description: true, costCodeId: true },
      }),
      prisma.costCode.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true } }),
    ]);

    if (activeCostCodes.length === 0) return;

    // Exclude section/category header rows the same way the manual "Auto-Assign
    // Phases" button does (EstimateEditor.handleAiAssignPhases) — a parent-less
    // item that has children is a section, not a line item, and should never
    // get a cost code.
    const isSection = (item: { id: string; parentId: string | null }) =>
      !item.parentId && allItems.some((i) => i.parentId === item.id);
    const uncoded = allItems.filter((item) => item.costCodeId == null && !isSection(item));
    if (uncoded.length === 0) return;

    const assignments = await matchItemsToCostCodes(
      uncoded.map((i) => ({ id: i.id, name: i.name, description: i.description ?? "" })),
      activeCostCodes,
    );

    const toApply = assignments.filter((a) => a.costCodeId);
    if (toApply.length === 0) return;

    // Per-item conditional write, not an all-or-nothing transaction: between the
    // read above and here, the user may have set a code themselves, or edited/
    // deleted an item. The costCodeId: null guard means a filled-in code is never
    // clobbered, the name guard means a classification for "Electrical" can't
    // land on an item since renamed "Plumbing" (the queued rerun above re-codes
    // it), and one item that's since been deleted/changed just no-ops instead of
    // rolling back every other assignment.
    const nameAtClassification = new Map(uncoded.map((i) => [i.id, i.name]));
    // Deliberately does NOT bump Estimate.itemsRevision. This runs from after() on every
    // saveEstimate, so bumping here would wedge the editor into a permanent conflict loop:
    // save → after() bumps the revision → the very next save (even from the same tab)
    // conflicts against a revision the editor never saw. It can still silently overwrite a
    // stale costCodeId from a stale editor session losing this race — pre-existing behavior,
    // unchanged by the itemsRevision work; see docs/specs/estimate-item-optimistic-concurrency.md
    // REVISION 2, "Deliberate non-goals".
    const results = await Promise.allSettled(
      toApply.map((a) =>
        prisma.estimateItem.updateMany({
          where: { id: a.id, estimateId, costCodeId: null, name: nameAtClassification.get(a.id) },
          data: { costCodeId: a.costCodeId },
        }),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      console.error(`[auto-assign-phases] ${failed}/${toApply.length} assignment writes failed for estimate`, estimateId);
    }
  } catch (e) {
    console.error(
      "[auto-assign-phases] auto-assign failed for estimate",
      estimateId,
      e instanceof Error ? e.message : e,
    );
  }
}
