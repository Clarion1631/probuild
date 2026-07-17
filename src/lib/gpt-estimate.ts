import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { transformPhasesToItems, toCents, type AiData } from "@/lib/ai-estimate-transform";

// Persists a phase-grouped estimate payload (the shape ChatGPT emits via the MCP
// connector) as a real Estimate. Reuses transformPhasesToItems so the MCP path,
// the editor's paste-import and the AI generator can never drift, then writes the
// grouped items with real parent/child links (unlike the flat takeoff conversion).
//
// Estimates land as status "Draft" / privacy "Private" so nothing AI-priced is
// visible in the customer portal until a human reviews and shares it.

// Shared with the MCP list tools: create_estimate only accepts targets those
// tools would surface.
export const CLOSED_PROJECT_STATUSES = ["Closed Complete", "Closed Lost"];
export const CLOSED_LEAD_STAGES = ["Won", "Closed Lost"];

export type CreateEstimateInput = {
    title: string;
    projectId?: string;
    leadId?: string;
    phases: AiData["phases"];
    paymentMilestones?: AiData["paymentMilestones"];
};

export type CreateEstimateResult =
    | {
          ok: true;
          estimateId: string;
          code: string;
          title: string;
          totalAmount: number;
          itemCount: number;
          url: string;
          warnings: string[];
      }
    | { ok: false; error: string };

// Validation failures raised inside the transaction; mapped to { ok: false }.
class EstimateInputError extends Error {}

/**
 * Converts a stored EstimateTemplate's flat item rows (Section rows + parentId
 * children) back into the phases[] shape create_estimate accepts, so ChatGPT can
 * pull a template, adjust it with the user, and push it back unchanged in form.
 */
export async function templateToPhases(templateName: string): Promise<
    | { ok: true; name: string; phases: { phaseName: string; phaseCode?: string; items: { name: string; description?: string; costCode?: string; costType?: string; quantity: number; unitCost: number }[] }[] }
    | { ok: false; error: string }
> {
    // Template names aren't unique — resolve case-insensitively but prefer an exact
    // match, and refuse ambiguity rather than answering non-deterministically.
    const matches = await prisma.estimateTemplate.findMany({
        where: { name: { equals: templateName, mode: "insensitive" } },
        include: { items: { orderBy: [{ order: "asc" }, { id: "asc" }] } },
    });
    if (matches.length === 0) return { ok: false, error: `No template named "${templateName}". Call list_templates for the catalog.` };
    const template = matches.find(t => t.name === templateName) ?? (matches.length === 1 ? matches[0] : null);
    if (!template) return { ok: false, error: `Multiple templates match "${templateName}" (${matches.map(t => `"${t.name}"`).join(", ")}). Use the exact name.` };

    // EstimateTemplateItem.costCodeId is a bare string (no relation) — map to codes manually.
    const costCodes = await prisma.costCode.findMany({ select: { id: true, code: true } });
    const codeById = new Map(costCodes.map(c => [c.id, c.code]));

    // Grouping is rebuilt by walking items in order (a Section row starts a phase;
    // the CHILD rows after it belong to that phase). Stored parentId values reference
    // rows of whatever estimate the template was saved from and can't be trusted,
    // but null-vs-set still marks top-level vs child. Genuinely top-level items
    // (and flat legacy templates) collect in an implicit phase.
    type Phase = { phaseName: string; phaseCode?: string; items: { name: string; description?: string; costCode?: string; costType?: string; quantity: number; unitCost: number }[] };
    const phases: Phase[] = [];
    let currentSection: Phase | null = null;
    let flat: Phase | null = null;

    for (const item of template.items) {
        if (item.type === "Section") {
            currentSection = { phaseName: item.name, phaseCode: (item.costCodeId && codeById.get(item.costCodeId)) || undefined, items: [] };
            phases.push(currentSection);
            continue;
        }
        let current = item.parentId != null ? currentSection : null;
        if (!current) {
            if (!flat) {
                flat = { phaseName: template.name, items: [] };
                phases.push(flat);
            }
            current = flat;
        }
        current.items.push({
            name: item.name,
            description: item.description ?? undefined,
            costCode: (item.costCodeId && codeById.get(item.costCodeId)) || undefined,
            costType: item.type,
            quantity: item.quantity,
            unitCost: Number(item.unitCost),
        });
    }

    return { ok: true, name: template.name, phases: phases.filter(p => p.items.length > 0) };
}

/**
 * Reads an EXISTING estimate (by EST-code or id) into the same phases[] shape
 * create_estimate accepts, so ChatGPT can revise a live estimate: read it,
 * change/drop items, then create the revised version as a new draft. Within one
 * estimate the parentId links are real (unlike template rows), so grouping is
 * taken directly from them.
 */
export async function estimateToPhases(codeOrId: string): Promise<
    | {
          ok: true;
          estimateId: string;
          code: string;
          title: string;
          status: string;
          projectId: string | null;
          leadId: string | null;
          totalAmount: number;
          taxExempt: boolean;
          phases: { phaseName: string; phaseCode?: string; items: { name: string; description?: string; costCode?: string; costType?: string; quantity: number; unitCost: number }[] }[];
          paymentMilestones: { name: string; percentage: number; amount: number }[];
      }
    | { ok: false; error: string }
> {
    const key = codeOrId.trim();
    const estimate = await prisma.estimate.findFirst({
        where: { OR: [{ code: { equals: key, mode: "insensitive" } }, { id: key }] },
        include: {
            items: { orderBy: [{ order: "asc" }, { id: "asc" }], include: { costCode: { select: { code: true } } } },
            paymentSchedules: { orderBy: { order: "asc" } },
        },
    });
    if (!estimate) return { ok: false, error: `No estimate matching "${codeOrId}". Use list_project_billing to find the estimate id or code.` };

    type Phase = { phaseName: string; phaseCode?: string; items: { name: string; description?: string; costCode?: string; costType?: string; quantity: number; unitCost: number }[] };
    const phases: Phase[] = [];
    const byId = new Map<string, Phase>();
    let flat: Phase | null = null;

    for (const item of estimate.items) {
        if (item.type === "Section") {
            const phase: Phase = { phaseName: item.name, phaseCode: item.costCode?.code ?? undefined, items: [] };
            phases.push(phase);
            byId.set(item.id, phase);
            continue;
        }
        let phase = item.parentId ? byId.get(item.parentId) : undefined;
        if (!phase) {
            if (!flat) { flat = { phaseName: estimate.title || "Items", items: [] }; phases.push(flat); }
            phase = flat;
        }
        phase.items.push({
            name: item.name,
            description: item.description ?? undefined,
            costCode: item.costCode?.code ?? undefined,
            costType: item.type,
            quantity: item.quantity,
            unitCost: Number(item.unitCost),
        });
    }

    const total = Number(estimate.totalAmount);
    return {
        ok: true,
        estimateId: estimate.id,
        code: estimate.code,
        title: estimate.title,
        status: estimate.status,
        projectId: estimate.projectId,
        leadId: estimate.leadId,
        totalAmount: total,
        taxExempt: !!estimate.taxExempt,
        phases: phases.filter(p => p.items.length > 0),
        paymentMilestones: estimate.paymentSchedules.map(m => ({
            name: m.name,
            percentage: m.percentage != null ? Number(m.percentage) : 0,
            amount: Number(m.amount),
        })),
    };
}

// Only estimates the customer has not yet committed to may be edited in place.
// "Sent" is still editable because sending does NOT sign or invoice — signing
// flips status to Approved and auto-creates the invoice (Estimate.invoices).
// The has-invoice / signed / approved checks below are the real gate; the status
// list is the coarse filter.
export const EDITABLE_ESTIMATE_STATUSES = ["Draft", "Sent"];

export type UpdateEstimateInput = {
    estimate: string; // EST-code or id
    title?: string;
    phases?: AiData["phases"];
    paymentMilestones?: AiData["paymentMilestones"];
    taxExempt?: boolean;
    taxRateName?: string | null;
    taxRatePercent?: number | null;
    memo?: string;
    termsAndConditions?: string;
};

export type UpdateEstimateResult =
    | {
          ok: true;
          estimateId: string;
          code: string;
          title: string;
          totalAmount: number;
          itemCount: number;
          url: string;
          changed: string[];
          warnings: string[];
      }
    | { ok: false; error: string };

// Reuse the create/transform path's exact cent rounding (no Number.EPSILON nudge)
// so update and create can never round a milestone or total differently.
const round2 = toCents;

// The tax model, mirrored from the app: an estimate's stored totalAmount is
// TAX-INCLUSIVE once a rate is chosen (deriveInvoiceTaxFields extracts tax back
// OUT of it at invoice time), and TAX-EXCLUSIVE while the rate is null (approval
// grosses it up once by the default rate — see ensureProjectAndDepositInvoiceForEstimate).
// So the invariant this tool must keep is: total = subtotal * (1 + effectiveRate/100),
// with effectiveRate = 0 when exempt and null when no rate is chosen (leave the
// subtotal untouched so the approval gross-up still fires).
function taxedTotal(subtotal: number, effectiveRate: number | null): number {
    if (effectiveRate == null) return round2(subtotal);
    return round2(subtotal * (1 + effectiveRate / 100));
}

// Re-proportions a milestone split across a (possibly new) total. Percentages are
// normalized to sum to exactly 100 so the amounts always cover the total, and the
// last milestone absorbs the rounding residual — identical to transformPhasesToItems.
type MilestoneSource = { name: string; percentage: number; dueDate: Date | null };
function recomputeMilestones(total: number, source: MilestoneSource[]): { name: string; percentage: number; amount: number; dueDate: Date | null; order: number }[] {
    if (source.length === 0) return [];
    let pcts = source.map(m => Number(m.percentage) || 0);
    const pctSum = round2(pcts.reduce((s, p) => s + p, 0));
    if (pctSum <= 0) {
        const eq = 100 / source.length;
        pcts = source.map(() => eq);
    } else if (Math.abs(pctSum - 100) > 0.01) {
        pcts = pcts.map(p => (p * 100) / pctSum);
    }
    // Stored percentages and amounts both let the LAST milestone absorb the
    // rounding residual, so each set sums to exactly 100 / to the total — a
    // round-tripped result therefore re-passes the "sum to 100" validation.
    let pctAllocated = 0;
    let allocated = 0;
    return source.map((m, idx) => {
        const isLast = idx === source.length - 1;
        const percentage = isLast ? round2(100 - pctAllocated) : round2(pcts[idx]);
        pctAllocated = round2(pctAllocated + percentage);
        const amount = isLast ? round2(total - allocated) : round2((percentage / 100) * total);
        allocated = round2(allocated + amount);
        return { name: m.name, percentage, amount, dueDate: m.dueDate ?? null, order: idx };
    });
}

/**
 * Edits an EXISTING estimate in place (the counterpart create_estimate lacks).
 * Hard guarantees:
 *   1. Math never drifts. Line items go through the SAME transformPhasesToItems
 *      the create path uses. The stored total always satisfies the tax invariant
 *      (see taxedTotal) whether items OR tax change, and milestone amounts are
 *      re-proportioned to sum to the new total exactly.
 *   2. Only uncommitted estimates are touched — refuses anything Approved,
 *      signed, or already carrying an invoice; the estimate row is locked
 *      FOR UPDATE and re-checked inside the transaction so a concurrent signing
 *      can't slip through.
 *   3. No silent data loss — refuses to rewrite line items that already have
 *      operational links (POs, time entries, schedule tasks, expenses).
 * `phases` replaces all line items; tax / title / memo / terms update
 * independently. A jurisdiction change needs taxRateName + taxRatePercent
 * together. Milestone edits require `phases`.
 */
export async function updateEstimateFromPhases(input: UpdateEstimateInput): Promise<UpdateEstimateResult> {
    const { estimate: key, title, phases, paymentMilestones, taxExempt, taxRateName, taxRatePercent, memo, termsAndConditions } = input;

    const wantsItems = Array.isArray(phases) && phases.length > 0;
    const wantsMilestones = Array.isArray(paymentMilestones) && paymentMilestones.length > 0;
    // A jurisdiction is a (name, rate) pair — accepting one without the other is
    // how you end up showing "Camas" next to Vancouver's rate. Move them together.
    if ((taxRateName !== undefined) !== (taxRatePercent !== undefined)) {
        return { ok: false, error: "Provide taxRateName and taxRatePercent together — a tax jurisdiction is a name plus its rate. (Use taxExempt on its own to toggle exemption.)" };
    }
    // Both must carry a value (apply a jurisdiction) or both be null (clear the
    // rate). A name with a null percent would leave the total tax-exclusive and
    // let the approval gross-up apply the DEFAULT rate under a "Camas" label.
    if (taxRateName !== undefined && taxRatePercent !== undefined && (taxRateName == null) !== (taxRatePercent == null)) {
        return { ok: false, error: "taxRateName and taxRatePercent must both be set to a value (to apply a jurisdiction) or both be null (to clear the tax rate)." };
    }
    const wantsTax = taxExempt !== undefined || taxRatePercent !== undefined;
    const wantsMeta = title !== undefined || memo !== undefined || termsAndConditions !== undefined;
    if (!wantsItems && !wantsMilestones && !wantsTax && !wantsMeta) {
        return { ok: false, error: "Nothing to update — provide phases, paymentMilestones, tax fields (taxExempt or taxRateName+taxRatePercent), title, memo, or termsAndConditions." };
    }
    if (wantsMilestones && !wantsItems) {
        return { ok: false, error: "paymentMilestones can only be changed together with phases (send the full line items so amounts recompute against the new total). To re-split payments only, edit the estimate in ProBuild." };
    }
    if (title !== undefined && !title.trim()) return { ok: false, error: "title cannot be blank." };
    if (wantsItems && !phases!.some(p => Array.isArray(p?.items) && p.items.length > 0)) {
        return { ok: false, error: "No phase contains line items — each phase needs a non-empty items array." };
    }
    if (wantsMilestones) {
        const pctSum = Math.round(paymentMilestones!.reduce((s, m) => s + (Number(m.percentage) || 0), 0) * 100) / 100;
        if (Math.abs(pctSum - 100) > 0.01) {
            return { ok: false, error: `paymentMilestones percentages must sum to 100 (got ${pctSum}).` };
        }
    }
    if (taxRatePercent != null && (taxRatePercent < 0 || taxRatePercent > 30)) {
        return { ok: false, error: `taxRatePercent must be between 0 and 30 (got ${taxRatePercent}).` };
    }

    const existing = await prisma.estimate.findFirst({
        where: { OR: [{ code: { equals: key.trim(), mode: "insensitive" } }, { id: key.trim() }] },
        select: {
            id: true, code: true, status: true, title: true, projectId: true, leadId: true,
            totalAmount: true, taxExempt: true, taxRatePercent: true, approvedAt: true, signatureUrl: true,
            _count: { select: { invoices: true } },
            paymentSchedules: { orderBy: { order: "asc" }, select: { name: true, percentage: true, amount: true, dueDate: true } },
        },
    });
    if (!existing) return { ok: false, error: `No estimate matching "${key}". Use list_project_billing or get_estimate to find the id or code.` };

    const editable = editabilityError(existing);
    if (editable) return { ok: false, error: editable };

    const oldTotal = Number(existing.totalAmount);

    // Cost code/type warnings + item transform, only when items are being rewritten.
    const warnings: string[] = [];
    let transformed: ReturnType<typeof transformPhasesToItems> | null = null;
    let idMap: Map<string, string> | null = null;
    if (wantsItems) {
        const [costCodes, costTypes] = await Promise.all([
            prisma.costCode.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true } }),
            prisma.costType.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
        ]);
        const knownCodes = new Set(costCodes.map(c => c.code));
        const knownTypes = new Set(costTypes.map(t => t.name));
        for (const phase of phases!) {
            if (phase?.phaseCode && !knownCodes.has(phase.phaseCode)) {
                warnings.push(`Unknown phase cost code "${phase.phaseCode}" (phase "${phase.phaseName ?? "?"}") — left uncoded.`);
            }
            for (const item of phase?.items ?? []) {
                if (item?.costCode && !knownCodes.has(item.costCode)) warnings.push(`Unknown cost code "${item.costCode}" on item "${item.name ?? "?"}" — left uncoded.`);
                if (item?.costType && !knownTypes.has(item.costType)) warnings.push(`Unknown cost type "${item.costType}" on item "${item.name ?? "?"}" — left uncoded.`);
            }
        }
        // paymentMilestones is ignored here — milestone math is done by
        // recomputeMilestones below so items and tax share one total path.
        transformed = transformPhasesToItems({ phases }, costCodes, costTypes);
        if (transformed.totalEstimate === 0) {
            warnings.push("Estimate total is $0 — every line item is quantity 0 (all optional). Give at least one line a real quantity unless a $0 estimate is intentional; milestones on a $0 total are all $0.");
        }
        idMap = new Map<string, string>();
        for (const item of transformed.items) idMap.set(item.id, randomUUID());
    }

    // --- Totals & tax (the invariant) ---------------------------------------
    // subtotal = tax-exclusive base. From the new items if rewriting, else strip
    // tax back out of the current stored total using its current effective rate.
    const currentEffectiveRate: number | null = existing.taxExempt
        ? 0
        : (existing.taxRatePercent != null ? Number(existing.taxRatePercent) : null);
    const subtotal = transformed
        ? transformed.totalEstimate
        : (currentEffectiveRate == null ? oldTotal : round2(oldTotal / (1 + currentEffectiveRate / 100)));

    const newExempt = taxExempt !== undefined ? !!taxExempt : existing.taxExempt;
    const newRatePercent: number | null = taxRatePercent !== undefined
        ? (taxRatePercent == null ? null : Number(taxRatePercent))
        : (existing.taxRatePercent != null ? Number(existing.taxRatePercent) : null);
    const newEffectiveRate: number | null = newExempt ? 0 : newRatePercent;

    const recomputeTotal = wantsItems || wantsTax;
    const newTotal = recomputeTotal ? taxedTotal(subtotal, newEffectiveRate) : oldTotal;
    const totalChanged = round2(newTotal) !== round2(oldTotal);

    // --- Milestones ----------------------------------------------------------
    // Rewrite when items change or the total moved. Source is the caller's split
    // (with phases) or the existing split carried over (percent derived from the
    // stored amount when absent so legacy schedules re-proportion), preserving
    // due dates by position.
    const milestoneSource: MilestoneSource[] = wantsMilestones
        ? paymentMilestones!.map(m => ({ name: m.name ?? "Payment", percentage: Number(m.percentage) || 0, dueDate: null }))
        : existing.paymentSchedules.map(s => ({
              name: s.name,
              percentage: s.percentage != null && Number(s.percentage) > 0
                  ? Number(s.percentage)
                  : (oldTotal > 0 ? (Number(s.amount) / oldTotal) * 100 : 0),
              dueDate: s.dueDate ?? null,
          }));
    const rewriteMilestones = (wantsItems || totalChanged) && (milestoneSource.length > 0 || wantsItems);
    const newMilestones = rewriteMilestones ? recomputeMilestones(newTotal, milestoneSource) : [];

    const changed: string[] = [];
    try {
        await prisma.$transaction(async tx => {
            // Lock the estimate row, then re-check editability against the freshest
            // state: approveEstimate (signing → invoice) could commit between the
            // read above and here. FOR UPDATE makes a concurrent signing block on
            // this row (or us on theirs) instead of interleaving.
            await tx.$queryRaw`SELECT id FROM "Estimate" WHERE id = ${existing.id} FOR UPDATE`;
            const fresh = await tx.estimate.findUnique({
                where: { id: existing.id },
                select: { status: true, approvedAt: true, signatureUrl: true, _count: { select: { invoices: true } } },
            });
            if (!fresh) throw new EstimateInputError("Estimate no longer exists.");
            const stillEditable = editabilityError(fresh);
            if (stillEditable) throw new EstimateInputError(stillEditable);

            if (wantsItems && transformed && idMap) {
                // Lock this estimate's item rows, then re-check for operational
                // links INSIDE the lock so a purchase-order/time/expense/task
                // assignment can't attach between the check and the deleteMany —
                // deleting a linked item would SetNull and silently orphan it.
                await tx.$queryRaw`SELECT id FROM "EstimateItem" WHERE "estimateId" = ${existing.id} FOR UPDATE`;
                const linked = await tx.estimateItem.count({
                    where: {
                        estimateId: existing.id,
                        OR: [
                            { purchaseOrderId: { not: null } },
                            { timeEntries: { some: {} } },
                            { expenses: { some: {} } },
                            { scheduleTask: { isNot: null } },
                        ],
                    },
                });
                if (linked > 0) {
                    throw new EstimateInputError(`Can't rewrite line items: ${linked} item(s) on this estimate already have linked purchase orders, time entries, expenses or schedule tasks. Edit the items in ProBuild so those links are preserved.`);
                }
                const mapParentId = (tempId: string): string => {
                    const mapped = idMap!.get(tempId);
                    if (!mapped) throw new Error(`transform produced item with unknown parentId "${tempId}"`);
                    return mapped;
                };
                await tx.estimateItem.deleteMany({ where: { estimateId: existing.id } });
                const parents = transformed.items.filter(i => !i.parentId);
                const children = transformed.items.filter(i => i.parentId);
                for (const group of [parents, children]) {
                    if (group.length === 0) continue;
                    await tx.estimateItem.createMany({
                        data: group.map(i => ({
                            id: idMap!.get(i.id)!,
                            estimateId: existing.id,
                            name: i.name,
                            description: i.description || null,
                            type: i.type,
                            quantity: i.quantity,
                            baseCost: i.baseCost,
                            markupPercent: i.markupPercent,
                            unitCost: i.unitCost,
                            total: i.total,
                            order: i.order,
                            parentId: i.parentId ? mapParentId(i.parentId) : null,
                            costCodeId: i.costCodeId,
                            costTypeId: i.costTypeId,
                        })),
                    });
                }
                changed.push(`line items (${transformed.items.length})`);
            }

            if (rewriteMilestones) {
                await tx.estimatePaymentSchedule.deleteMany({ where: { estimateId: existing.id } });
                if (newMilestones.length > 0) {
                    await tx.estimatePaymentSchedule.createMany({
                        data: newMilestones.map(m => ({
                            estimateId: existing.id,
                            name: m.name,
                            percentage: m.percentage,
                            amount: m.amount,
                            dueDate: m.dueDate,
                            order: m.order,
                        })),
                    });
                    changed.push(`payment milestones (${newMilestones.length})`);
                }
            }

            const data: Record<string, unknown> = {};
            if (title !== undefined) { data.title = title.trim(); changed.push("title"); }
            if (memo !== undefined) { data.memo = memo; changed.push("memo"); }
            if (termsAndConditions !== undefined) { data.termsAndConditions = termsAndConditions; changed.push("terms"); }
            if (taxExempt !== undefined) { data.taxExempt = newExempt; changed.push("taxExempt"); }
            if (taxRateName !== undefined) { data.taxRateName = taxRateName; }
            if (taxRatePercent !== undefined) { data.taxRatePercent = taxRatePercent; }
            if (taxRatePercent !== undefined || taxRateName !== undefined) changed.push("tax rate");
            // balanceDue tracks totalAmount 1:1 here — the has-invoice/paid gate
            // guarantees no payment has been applied, so there is nothing to net out.
            if (recomputeTotal && totalChanged) { data.totalAmount = newTotal; data.balanceDue = newTotal; changed.push("total"); }
            else if (recomputeTotal) { data.totalAmount = newTotal; data.balanceDue = newTotal; }
            if (Object.keys(data).length > 0) await tx.estimate.update({ where: { id: existing.id }, data });
        });
    } catch (err) {
        if (err instanceof EstimateInputError) return { ok: false, error: err.message };
        throw err;
    }

    const url = existing.projectId
        ? `https://probuild.goldentouchremodeling.com/projects/${existing.projectId}/estimates/${existing.id}`
        : `https://probuild.goldentouchremodeling.com/leads/${existing.leadId}/estimates/${existing.id}`;

    return {
        ok: true,
        estimateId: existing.id,
        code: existing.code,
        title: title?.trim() ?? existing.title,
        totalAmount: recomputeTotal ? newTotal : oldTotal,
        itemCount: transformed ? transformed.items.length : 0,
        url,
        changed: [...new Set(changed)],
        warnings,
    };
}

// Returns a human-readable refusal if the estimate is past the point where an
// AI edit is safe (signed / approved / already invoiced), or null if editable.
function editabilityError(e: { status: string; approvedAt: Date | null; signatureUrl: string | null; _count: { invoices: number } }): string | null {
    if (e._count.invoices > 0) {
        return "This estimate already has an invoice (it was signed/converted). Editing it would desync the invoice, its milestones and QuickBooks — make changes with a change order, or edit it in ProBuild.";
    }
    if (e.approvedAt || e.signatureUrl) {
        return "This estimate has been signed/approved by the customer and can't be edited. Use a change order for revisions.";
    }
    if (!EDITABLE_ESTIMATE_STATUSES.includes(e.status)) {
        return `Only Draft or Sent (unsigned) estimates can be edited here; this one is "${e.status}". Use a change order for revisions.`;
    }
    return null;
}

export async function createEstimateFromPhases(input: CreateEstimateInput): Promise<CreateEstimateResult> {
    const { title, projectId, leadId, phases, paymentMilestones } = input;

    if (!title?.trim()) return { ok: false, error: "title is required" };
    if ((projectId ? 1 : 0) + (leadId ? 1 : 0) !== 1) {
        return { ok: false, error: "Provide exactly one of projectId or leadId (use list_projects / list_leads to find the right one)." };
    }
    if (!Array.isArray(phases) || phases.length === 0) {
        return { ok: false, error: 'phases must be a non-empty array of { phaseName, items: [...] }.' };
    }
    const hasItems = phases.some(p => Array.isArray(p?.items) && p.items.length > 0);
    if (!hasItems) return { ok: false, error: "No phase contains line items — each phase needs an items array." };

    if (paymentMilestones && paymentMilestones.length > 0) {
        // Same rounded-to-2dp predicate as the transform's coversTotal check, so a
        // set that passes here always gets the residual-absorbing last milestone.
        const pctSum = Math.round(paymentMilestones.reduce((s, m) => s + (Number(m.percentage) || 0), 0) * 100) / 100;
        if (Math.abs(pctSum - 100) > 0.01) {
            return { ok: false, error: `paymentMilestones percentages must sum to 100 (got ${pctSum}).` };
        }
    }

    const [costCodes, costTypes] = await Promise.all([
        prisma.costCode.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true } }),
        prisma.costType.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    ]);

    // Surface unmatched codes/types as warnings rather than failing the import —
    // the transform leaves those items uncoded and the editor can fix them.
    const knownCodes = new Set(costCodes.map(c => c.code));
    const knownTypes = new Set(costTypes.map(t => t.name));
    const warnings: string[] = [];
    for (const phase of phases) {
        if (phase?.phaseCode && !knownCodes.has(phase.phaseCode)) {
            warnings.push(`Unknown phase cost code "${phase.phaseCode}" (phase "${phase.phaseName ?? "?"}") — left uncoded.`);
        }
        for (const item of phase?.items ?? []) {
            if (item?.costCode && !knownCodes.has(item.costCode)) {
                warnings.push(`Unknown cost code "${item.costCode}" on item "${item.name ?? "?"}" — left uncoded.`);
            }
            if (item?.costType && !knownTypes.has(item.costType)) {
                warnings.push(`Unknown cost type "${item.costType}" on item "${item.name ?? "?"}" — left uncoded.`);
            }
        }
    }

    const transformed = transformPhasesToItems(
        { phases, paymentMilestones: paymentMilestones ?? [] },
        costCodes,
        costTypes,
    );
    if (transformed.totalEstimate === 0) {
        warnings.push("Estimate total is $0 — every line item is quantity 0 (all optional). Give at least one line a real quantity unless a $0 estimate is intentional; milestones on a $0 total are all $0.");
    }

    // The transform emits placeholder ids (imp_<ts>_p0, ...) with parentId references;
    // remap them to fresh ids so they can be persisted with real parent links.
    const idMap = new Map<string, string>();
    for (const item of transformed.items) idMap.set(item.id, randomUUID());
    const mapParentId = (tempId: string): string => {
        const mapped = idMap.get(tempId);
        if (!mapped) throw new Error(`transform produced item with unknown parentId "${tempId}"`);
        return mapped;
    };

    let estimate;
    try {
        estimate = await prisma.$transaction(async tx => {
            // Target checks live inside the transaction so a concurrent delete can't
            // slip between validation and insert, and only open records qualify —
            // the same filter list_projects / list_leads apply. A status change in
            // the instant between this check and commit is accepted: worst case is
            // a Draft/Private estimate on a just-closed record, which is harmless
            // and not worth a row lock.
            if (projectId) {
                const project = await tx.project.findFirst({
                    where: { id: projectId, status: { notIn: CLOSED_PROJECT_STATUSES } },
                    select: { id: true },
                });
                if (!project) throw new EstimateInputError(`No open project with id ${projectId}. Call list_projects for valid ids.`);
            } else if (leadId) {
                const lead = await tx.lead.findFirst({
                    where: { id: leadId, stage: { notIn: CLOSED_LEAD_STAGES } },
                    select: { id: true },
                });
                if (!lead) throw new EstimateInputError(`No open lead with id ${leadId}. Call list_leads for valid ids.`);
            }

            // EST-TEMP then rename from the autoincrement `number` — the same
            // collision-free pattern the app's own estimate creation uses.
            const created = await tx.estimate.create({
                data: {
                    title: title.trim(),
                    projectId: projectId ?? null,
                    leadId: leadId ?? null,
                    code: "EST-TEMP",
                    status: "Draft",
                    privacy: "Private",
                    totalAmount: transformed.totalEstimate,
                    balanceDue: transformed.totalEstimate,
                },
            });
            const est = await tx.estimate.update({
                where: { id: created.id },
                data: { code: `EST-${String(created.number).padStart(5, "0")}` },
            });

            const parents = transformed.items.filter(i => !i.parentId);
            const children = transformed.items.filter(i => i.parentId);
            for (const group of [parents, children]) {
                if (group.length === 0) continue;
                await tx.estimateItem.createMany({
                    data: group.map(i => ({
                        id: idMap.get(i.id)!,
                        estimateId: est.id,
                        name: i.name,
                        description: i.description || null,
                        type: i.type,
                        quantity: i.quantity,
                        baseCost: i.baseCost,
                        markupPercent: i.markupPercent,
                        unitCost: i.unitCost,
                        total: i.total,
                        order: i.order,
                        parentId: i.parentId ? mapParentId(i.parentId) : null,
                        costCodeId: i.costCodeId,
                        costTypeId: i.costTypeId,
                    })),
                });
            }

            if (transformed.paymentMilestones.length > 0) {
                await tx.estimatePaymentSchedule.createMany({
                    data: transformed.paymentMilestones.map((m, idx) => ({
                        estimateId: est.id,
                        name: m.name,
                        percentage: parseFloat(m.percentage) || 0,
                        amount: parseFloat(m.amount) || 0,
                        order: idx,
                    })),
                });
            }

            return est;
        });
    } catch (err) {
        if (err instanceof EstimateInputError) return { ok: false, error: err.message };
        throw err;
    }

    const url = projectId
        ? `https://probuild.goldentouchremodeling.com/projects/${projectId}/estimates/${estimate.id}`
        : `https://probuild.goldentouchremodeling.com/leads/${leadId}/estimates/${estimate.id}`;

    return {
        ok: true,
        estimateId: estimate.id,
        code: estimate.code,
        title: estimate.title,
        totalAmount: transformed.totalEstimate,
        itemCount: transformed.items.length,
        url,
        warnings,
    };
}
