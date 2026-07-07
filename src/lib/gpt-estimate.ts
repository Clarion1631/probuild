import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { transformPhasesToItems, type AiData } from "@/lib/ai-estimate-transform";

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
