import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { extractJsonObject } from "./ai-json";
import { isEstimateSectionRow } from "./estimate-item-payload";

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
// Hard cap on how many times one after() invocation will chain a follow-up run. Sustained
// editing repopulates rerunQueued on every pass, and because the chain is awaited inside the
// tracked promise (see below) an unbounded chain would keep one serverless invocation alive
// through an arbitrary number of AI calls until the platform's max duration killed it — losing
// the final run anyway. Stopping deliberately is better: the NEXT save starts a fresh, tracked
// run, so the work is picked up by a live invocation rather than a dying one.
const MAX_RERUN_CHAIN = 3;

export async function autoAssignPhasesForEstimate(estimateId: string, chainDepth = 0): Promise<void> {
  // Deterministic off switch for tests. The e2e drill simulates the assignment with a direct DB
  // write, so a real classifier running concurrently would race it (CI does supply
  // ANTHROPIC_API_KEY). Mirrors the existing DAILY_LOG_MATCH_AI_MOCK pattern.
  if (process.env.AUTO_ASSIGN_PHASES_AI_MOCK === "1") return;

  const existing = inFlight.get(estimateId);
  if (existing) {
    // A newer save arrived mid-run — its items may differ from what the running
    // job read, so queue exactly one follow-up run instead of just sharing the
    // (potentially stale) in-flight result.
    rerunQueued.add(estimateId);
    return existing;
  }

  const run = (async () => {
    try {
      await runAutoAssignPhasesForEstimate(estimateId);
    } finally {
      // Cleared BEFORE the rerun below, or the rerun would dedupe into the very run it is
      // following and do nothing.
      inFlight.delete(estimateId);
    }
    // Awaited, not floated. This used to be `void autoAssignPhasesForEstimate(...)`, which
    // detached the rerun from the promise the caller's after() is tracking — and serverless
    // only keeps the invocation alive for the promise it was handed, so the rerun could be
    // frozen mid-flight and the newer items never got coded. Awaiting keeps it inside the
    // tracked promise, and MAX_RERUN_CHAIN keeps that promise from living forever.
    if (rerunQueued.delete(estimateId)) {
      if (chainDepth + 1 < MAX_RERUN_CHAIN) {
        await autoAssignPhasesForEstimate(estimateId, chainDepth + 1);
      } else {
        // Not an error: the items are still uncoded, and the next save's own after() will run
        // this again from a fresh invocation. Logged because a chain hitting the cap means
        // someone is saving faster than the classifier returns.
        console.warn("[auto-assign-phases] rerun chain cap reached, deferring to next save for estimate", estimateId);
      }
    }
  })();
  inFlight.set(estimateId, run);
  return run;
}

async function runAutoAssignPhasesForEstimate(estimateId: string): Promise<void> {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return;

    const [allItems, activeCostCodes] = await Promise.all([
      prisma.estimateItem.findMany({
        where: { estimateId },
        // `type` is selected for the section check below — without it this side of the check
        // disagreed with every other reader of the item tree.
        select: { id: true, parentId: true, type: true, name: true, description: true, costCodeId: true },
      }),
      prisma.costCode.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true } }),
    ]);

    if (activeCostCodes.length === 0) return;

    // Exclude section/category header rows — a header's total is the roll-up of its children,
    // so it is not a line item and must never get a cost code.
    //
    // Uses the SHARED predicate (`type === "Section"` OR has children) rather than the local
    // "parentless AND has children" rule this used to carry. That old rule disagreed with every
    // other reader of the item tree in two ways: a NESTED section (it has a parent) and an EMPTY
    // named section (no children yet) both looked like ordinary line items, so the AI coded them.
    // The editor's catch-up excludes them, so those codes were then invisible to it and its next
    // save nulled them right back out — and in the meantime they surfaced as real project cost
    // codes. One predicate, one answer.
    const uncoded = allItems.filter(
      (item) => item.costCodeId == null && !isEstimateSectionRow(item, allItems),
    );
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
    // clobbered, the name+description guard means a classification for "Electrical"
    // can't land on an item since edited to read "Plumbing" (the queued rerun above
    // re-codes it), and one item that's since been deleted/changed just no-ops
    // instead of rolling back every other assignment.
    // Both fields, because the classifier reads both (see the matchItemsToCostCodes call above).
    // Guarding on name alone let a description-only edit slip through: the row still matched, so a
    // code classified against the OLD description landed on it, and because the row was no longer
    // null the queued rerun skipped it — leaving the stale classification permanently in place.
    const inputAtClassification = new Map(uncoded.map((i) => [i.id, { name: i.name, description: i.description }]));
    // Deliberately does NOT bump Estimate.itemsRevision. This runs from after() on every
    // saveEstimate, so bumping here would wedge the editor into a permanent conflict loop:
    // save → after() bumps the revision → the very next save (even from the same tab)
    // conflicts against a revision the editor never saw. It can still silently overwrite a
    // stale costCodeId from a stale editor session losing this race — pre-existing behavior,
    // unchanged by the itemsRevision work; see docs/specs/estimate-item-optimistic-concurrency.md
    // REVISION 2, "Deliberate non-goals".
    // Entries with no recorded classification input are dropped outright rather than written
    // with a placeholder predicate: `{ id: "" }` is ordinary text equality, not a guaranteed
    // match-none, so a row with an empty id would have been updated with NO estimate/name/
    // description guard at all. Skipping is the only safe direction. (`at` should always be
    // present — toApply derives from uncoded — but the matcher trims and caps ids, so a
    // non-canonical id could in principle miss the raw-id map.)
    const writable = toApply
      .map((a) => ({ a, at: inputAtClassification.get(a.id) }))
      .filter((entry): entry is { a: typeof entry.a; at: NonNullable<typeof entry.at> } => !!entry.at);
    const results = await Promise.allSettled(
      writable.map(({ a, at }) =>
        prisma.estimateItem.updateMany({
          where: { id: a.id, estimateId, costCodeId: null, name: at.name, description: at.description },
          data: { costCodeId: a.costCodeId },
        }),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      console.error(`[auto-assign-phases] ${failed}/${writable.length} assignment writes failed for estimate`, estimateId);
    }
  } catch (e) {
    console.error(
      "[auto-assign-phases] auto-assign failed for estimate",
      estimateId,
      e instanceof Error ? e.message : e,
    );
  }
}
