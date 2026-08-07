import { prisma } from "./prisma";
import { dateInputInTimeZone, resolveCompanyTimeZone } from "./company-timezone";
import { billableCoItems, coLineCents, coSectionRowError, coSectionRowNames } from "./co-tax";

type ChangeOrderItemInput = {
    id?: string;
    name?: string;
    description?: string | null;
    type?: string;
    quantity?: string | number;
    unitCost?: string | number;
    order?: number;
    costCodeId?: string | null;
    costTypeId?: string | null;
};

type ChangeOrderScheduleInput = {
    id?: string;
    name?: string;
    amount?: string | number;
    dueDate?: string | Date | null;
    order?: number;
};

export type ChangeOrderUpdateInput = {
    title?: string;
    description?: string | null;
    pricingType?: "FIXED" | "COST_PLUS";
    markupPercent?: string | number | null;
    paymentSchedules?: ChangeOrderScheduleInput[] | unknown;
    status?: unknown;
    items?: ChangeOrderItemInput[] | unknown;
    [key: string]: unknown;
};

function normalizedPricingType(value: unknown, fallback: string): "FIXED" | "COST_PLUS" {
    const pricingType = value ?? fallback;
    if (pricingType !== "FIXED" && pricingType !== "COST_PLUS") {
        throw new Error("Pricing type must be FIXED or COST_PLUS.");
    }
    return pricingType;
}

function normalizedMarkup(value: unknown, fallback: number | null): number | null {
    if (value === undefined) return fallback;
    if (value === null || value === "") return null;
    const markup = Number(value);
    if (!Number.isFinite(markup) || markup < 0 || markup > 1_000) {
        throw new Error("Markup percent must be between 0 and 1000.");
    }
    return markup;
}

function normalizeSchedules(
    schedules: ChangeOrderScheduleInput[],
    subtotalCents: number,
    timeZone: string,
): Array<{ id?: string; name: string; amount: number; dueDate: Date | null; order: number }> {
    if (schedules.length === 0) return [];
    if (schedules.length < 2) throw new Error("A fixed-price payment schedule requires at least two payments.");

    let priorCents = 0;
    return schedules.map((schedule, index) => {
        const isLast = index === schedules.length - 1;
        const requestedCents = Math.round(Number(schedule.amount ?? 0) * 100);
        const amountCents = isLast ? subtotalCents - priorCents : requestedCents;
        if (!Number.isSafeInteger(requestedCents) || requestedCents <= 0 || amountCents <= 0) {
            throw new Error("Every scheduled payment must be positive and earlier payments must total less than the subtotal.");
        }
        priorCents += amountCents;
        const name = schedule.name?.trim() || `Payment ${index + 1}`;
        const dueDate = dateInputInTimeZone(schedule.dueDate, timeZone, `Due date for ${name}`);
        return { id: schedule.id, name, amount: amountCents / 100, dueDate, order: schedule.order ?? index };
    });
}

function itemSubtotalCents(items: Array<{ type?: string | null; quantity: number; unitCost: unknown }>): number {
    return billableCoItems(items).reduce((sum, item) => sum + coLineCents(item.quantity, Number(item.unitCost)), 0);
}

/**
 * Session-free change-order persistence used by the permission-gated server
 * action. Keeping the transaction outside actions.ts lets money-path tests
 * exercise the real row locks and writes without exposing an auth-free server
 * action (only exports from a `"use server"` module are remotely invokable).
 */
export async function updateChangeOrderCore(id: string, data: ChangeOrderUpdateInput) {
    const items = Array.isArray(data.items) ? data.items as ChangeOrderItemInput[] : undefined;
    const schedules = Array.isArray(data.paymentSchedules) ? data.paymentSchedules as ChangeOrderScheduleInput[] : undefined;
    const timeZone = await resolveCompanyTimeZone();

    return prisma.$transaction(async (tx) => {
        // Serialize editors with send, approval, billing, and co-audit repair.
        const locked = await tx.$queryRaw<Array<{
            code: string;
            status: string;
            title: string;
            description: string | null;
            totalAmount: unknown;
            pricingType: string;
            markupPercent: number | null;
            approvedBy: string | null;
            approvedAt: Date | null;
            clientSignatureUrl: string | null;
            companySignedBy: string | null;
            companySignedAt: Date | null;
            companySignatureUrl: string | null;
        }>>`
            SELECT "code", "status", "title", "description", "totalAmount", "pricingType", "markupPercent",
                   "approvedBy", "approvedAt", "clientSignatureUrl",
                   "companySignedBy", "companySignedAt", "companySignatureUrl"
            FROM "ChangeOrder" WHERE "id" = ${id} FOR UPDATE`;
        const current = locked[0];
        if (!current) throw new Error("Change order not found");

        // Status transitions are lifecycle operations, never generic field
        // updates. In particular, Draft -> Sent must go through
        // sendChangeOrderToClientCore so item/subtotal validation and sentAt are
        // inseparable from the client notification path.
        if (Object.prototype.hasOwnProperty.call(data, "status")) {
            throw new Error("Change order status cannot be updated here. Use Send for Approval so the guarded send workflow owns the transition.");
        }

        // An Approved CO is the scope and amount the customer signed and billing
        // consumed. Lock all signed scope fields, not only line items, so the
        // portal/PDF cannot drift from the approval audit trail afterward.
        const hasScopeWrite = ["title", "description", "items", "pricingType", "markupPercent", "paymentSchedules"]
            .some((field) => Object.prototype.hasOwnProperty.call(data, field));
        const hasSignatureAudit = Boolean(
            current.approvedBy
            || current.approvedAt
            || current.clientSignatureUrl
            || current.companySignedBy
            || current.companySignedAt
            || current.companySignatureUrl,
        );
        if ((current.status === "Approved" || hasSignatureAudit) && hasScopeWrite) {
            throw new Error("This change order's signed scope is locked. Create a new change order for additional work.");
        }

        const scalarData: Record<string, unknown> = {};
        let scopeChanged = false;
        if (data.title !== undefined) {
            scalarData.title = data.title;
            scopeChanged = data.title !== current.title;
        }
        if (data.description !== undefined) {
            const nextDescription = data.description === "" ? null : data.description;
            scalarData.description = nextDescription;
            scopeChanged = scopeChanged || nextDescription !== current.description;
        }

        const nextPricingType = normalizedPricingType(data.pricingType, current.pricingType);
        const nextMarkupPercent = normalizedMarkup(data.markupPercent, current.markupPercent);
        if (data.pricingType !== undefined) {
            scalarData.pricingType = nextPricingType;
            scopeChanged = scopeChanged || nextPricingType !== current.pricingType;
        }
        if (data.markupPercent !== undefined) {
            scalarData.markupPercent = nextMarkupPercent;
            scopeChanged = scopeChanged || nextMarkupPercent !== current.markupPercent;
        }

        if (items) {
            const itemIds = items
                .map((item) => item.id)
                .filter((itemId): itemId is string => typeof itemId === "string" && itemId.length > 0);
            const seenItemIds = new Set<string>();
            const duplicateItemId = itemIds.find((itemId) => {
                if (seenItemIds.has(itemId)) return true;
                seenItemIds.add(itemId);
                return false;
            });
            if (duplicateItemId) {
                throw new Error(`Duplicate change-order item ID: ${duplicateItemId}`);
            }

            const existing = await tx.changeOrderItem.findMany({
                where: { changeOrderId: id },
                select: {
                    id: true,
                    name: true,
                    description: true,
                    type: true,
                    quantity: true,
                    unitCost: true,
                    total: true,
                    order: true,
                    costCodeId: true,
                    costTypeId: true,
                },
            });
            const existingIds = new Set(existing.map(i => i.id));
            const existingById = new Map(existing.map((item) => [item.id, item]));

            const rows = items.map((item, idx) => {
                const quantity = parseFloat(String(item.quantity ?? "")) || 0;
                const unitCost = parseFloat(String(item.unitCost ?? "")) || 0;
                const unitCents = Math.round(unitCost * 100);
                const lineCents = coLineCents(quantity, unitCost);
                // On a row that matches an existing item, an omitted (undefined)
                // description/costCodeId/costTypeId keeps the stored value —
                // resolved here, under the same row lock as the write, so a
                // partial payload can't erase relations it never mentioned. The
                // editor always sends explicit values (x || null), so this only
                // affects connector callers. Empty string / null still clears.
                const prior = item.id ? existingById.get(item.id) : undefined;
                // `type` is keep-prior too (the MCP omits it whenever costType is omitted),
                // and the *effective* type is what decides whether this row is billable. Read
                // the stored value here or the subtotal computed below would disagree with the
                // one the send and approval guards recompute after reload — a mismatch those
                // guards treat as "out of sync with its items", permanently.
                const effectiveType = item.type ?? prior?.type ?? undefined;
                return {
                    id: item.id || undefined,
                    name: item.name || "",
                    description: item.description === undefined ? (prior?.description ?? null) : (item.description || null),
                    ...(effectiveType ? { type: effectiveType } : {}),
                    quantity,
                    unitCost: unitCents / 100,
                    total: lineCents / 100,
                    order: item.order ?? idx,
                    costCodeId: item.costCodeId === undefined ? (prior?.costCodeId ?? null) : (item.costCodeId || null),
                    costTypeId: item.costTypeId === undefined ? (prior?.costTypeId ?? null) : (item.costTypeId || null),
                };
            });
            // Refuse a section header at the point it would enter the change order, rather
            // than storing a row every downstream reader then has to second-guess.
            const sectionRows = coSectionRowNames(rows);
            if (sectionRows.length > 0) throw new Error(coSectionRowError(current.code, sectionRows));

            const totalCents = itemSubtotalCents(rows);
            const incomingIds = new Set(rows.map(r => r.id).filter(Boolean));
            const toDelete = existing.filter(i => !incomingIds.has(i.id)).map(i => i.id);
            const itemRowsChanged = rows.length !== existing.length || rows.some((row) => {
                if (!row.id) return true;
                const prior = existingById.get(row.id);
                if (!prior) return true;
                return prior.name !== row.name
                    || prior.description !== row.description
                    || (row.type !== undefined && prior.type !== row.type)
                    || prior.quantity !== row.quantity
                    || Number(prior.unitCost) !== row.unitCost
                    || Number(prior.total) !== row.total
                    || prior.order !== row.order
                    || prior.costCodeId !== row.costCodeId
                    || prior.costTypeId !== row.costTypeId;
            });
            scopeChanged = scopeChanged
                || itemRowsChanged
                || Math.round(Number(current.totalAmount) * 100) !== totalCents;
            if (toDelete.length > 0) {
                await tx.changeOrderItem.deleteMany({ where: { id: { in: toDelete }, changeOrderId: id } });
            }
            for (const row of rows) {
                const { id: itemId, ...itemData } = row;
                if (itemId && existingIds.has(itemId)) {
                    await tx.changeOrderItem.update({ where: { id: itemId }, data: itemData });
                } else {
                    await tx.changeOrderItem.create({ data: { ...itemData, ...(itemId ? { id: itemId } : {}), changeOrderId: id } });
                }
            }

            scalarData.totalAmount = totalCents / 100;
            scalarData.balanceDue = totalCents / 100;
        }


        const subtotalCents = scalarData.totalAmount === undefined
            ? Math.round(Number(current.totalAmount) * 100)
            : Math.round(Number(scalarData.totalAmount) * 100);
        const existingSchedules = await tx.changeOrderPaymentSchedule.findMany({
            where: { changeOrderId: id },
            orderBy: [{ order: "asc" }, { id: "asc" }],
            select: { id: true, name: true, amount: true, dueDate: true, order: true },
        });
        // Same keep-prior rule as item fields: an omitted (undefined) dueDate on
        // a row that matches an existing schedule keeps the stored date; null or
        // "" still clears it. Resolved under the row lock.
        const priorScheduleById = new Map(existingSchedules.map((row) => [row.id, row]));
        const requestedSchedules = schedules
            ? schedules.map((row) => ({
                ...row,
                dueDate: row.dueDate === undefined && row.id && priorScheduleById.has(row.id)
                    ? priorScheduleById.get(row.id)!.dueDate
                    : row.dueDate,
            }))
            : existingSchedules.map((row) => ({
                id: row.id,
                name: row.name,
                amount: Number(row.amount),
                dueDate: row.dueDate,
                order: row.order,
            }));

        if (nextPricingType === "COST_PLUS" && requestedSchedules.length > 0) {
            throw new Error("Cost-plus change orders cannot have a fixed payment schedule.");
        }
        const normalizedSchedules = nextPricingType === "FIXED"
            ? normalizeSchedules(requestedSchedules, subtotalCents, timeZone)
            : [];

        if (schedules !== undefined) {
            const requestedIds = schedules.map((row) => row.id).filter((value): value is string => Boolean(value));
            if (new Set(requestedIds).size !== requestedIds.length) throw new Error("Duplicate payment schedule ID.");
            const existingById = new Map(existingSchedules.map((row) => [row.id, row]));
            const incomingIds = new Set(normalizedSchedules.map((row) => row.id).filter((value): value is string => Boolean(value)));
            const deleteIds = existingSchedules.filter((row) => !incomingIds.has(row.id)).map((row) => row.id);
            if (deleteIds.length) await tx.changeOrderPaymentSchedule.deleteMany({ where: { changeOrderId: id, id: { in: deleteIds } } });
            for (const row of normalizedSchedules) {
                const { id: scheduleId, ...scheduleData } = row;
                if (scheduleId && existingById.has(scheduleId)) {
                    await tx.changeOrderPaymentSchedule.update({ where: { id: scheduleId }, data: scheduleData });
                } else {
                    await tx.changeOrderPaymentSchedule.create({ data: { ...scheduleData, changeOrderId: id } });
                }
            }
            const schedulesChanged = normalizedSchedules.length !== existingSchedules.length
                || normalizedSchedules.some((row) => {
                    const prior = row.id ? existingById.get(row.id) : undefined;
                    return !prior
                        || prior.name !== row.name
                        || Math.round(Number(prior.amount) * 100) !== Math.round(row.amount * 100)
                        || prior.dueDate?.getTime() !== row.dueDate?.getTime()
                        || prior.order !== row.order;
                });
            scopeChanged = scopeChanged || schedulesChanged;
        } else if (nextPricingType === "FIXED" && existingSchedules.length > 0) {
            // An item edit can change the subtotal. Keep the signed schedule contract
            // cent-exact by absorbing the difference into the final row.
            const final = normalizedSchedules.at(-1)!;
            const priorFinal = existingSchedules.at(-1)!;
            if (Math.round(Number(priorFinal.amount) * 100) !== Math.round(final.amount * 100)) {
                await tx.changeOrderPaymentSchedule.update({ where: { id: priorFinal.id }, data: { amount: final.amount } });
                scopeChanged = true;
            }
        }

        // A client may already have the Sent document open. An actual scope
        // change invalidates that render, so atomically return the CO to Draft
        // and force a fresh guarded send before approval can succeed. No-op saves
        // remain Sent.
        if (current.status === "Sent" && scopeChanged) {
            scalarData.status = "Draft";
            scalarData.sentAt = null;
            scalarData.viewedAt = null;
        }

        return tx.changeOrder.update({ where: { id }, data: scalarData });
    }, { timeout: 15_000 });
}

export async function approveChangeOrderCore(
    id: string,
    approval: { signatureName: string; clientSignatureUrl: string | null; approvedAt: Date },
) {
    return prisma.$transaction(async (tx) => {
        // The same parent-row lock is taken by editing, sending, billing, and
        // co-audit repair. Status, item existence, subtotal validation, and the
        // approval write therefore observe one serialized state and commit as a
        // single invariant-preserving transition.
        const locked = await tx.$queryRaw<Array<{ id: string; code: string; status: string; pricingType: string; totalAmount: unknown }>>`
            SELECT "id", "code", "status", "pricingType", "totalAmount"
            FROM "ChangeOrder" WHERE "id" = ${id} FOR UPDATE`;
        const current = locked[0];
        if (!current) return null;

        if (current.status !== "Sent") {
            throw new Error(`Change order ${current.code} must be Sent before it can be approved.`);
        }

        if (!approval.signatureName.trim() || !approval.clientSignatureUrl) {
            throw new Error("A client name and persisted signature is required to approve a change order.");
        }

        if (current.pricingType === "COST_PLUS") {
            const scheduleCount = await tx.changeOrderPaymentSchedule.count({ where: { changeOrderId: id } });
            if (scheduleCount > 0) throw new Error("Cost-plus change orders cannot have a fixed payment schedule.");
        }

        const items = await tx.changeOrderItem.findMany({
            where: { changeOrderId: id },
            select: { name: true, type: true, quantity: true, unitCost: true },
        });
        // Legacy rows written before section headers were rejected at the write path.
        const sectionRows = coSectionRowNames(items);
        if (sectionRows.length > 0) throw new Error(coSectionRowError(current.code, sectionRows));
        if (current.pricingType !== "COST_PLUS" && items.length === 0) {
            throw new Error(`Change order ${current.code} must contain at least one priced item before it can be approved.`);
        }

        const storedSubtotalCents = Math.round(Number(current.totalAmount) * 100);
        const renderedSubtotalCents = itemSubtotalCents(items);
        if (current.pricingType !== "COST_PLUS" && (storedSubtotalCents <= 0 || renderedSubtotalCents <= 0)) {
            throw new Error(`Change order ${current.code} must have a positive subtotal before it can be approved.`);
        }
        if (current.pricingType !== "COST_PLUS" && storedSubtotalCents !== renderedSubtotalCents) {
            throw new Error(`Change order ${current.code} pricing is out of sync with its items — save and resend it before approval.`);
        }

        const co = await tx.changeOrder.update({
            where: { id },
            data: {
                status: "Approved",
                approvedBy: approval.signatureName.trim(),
                approvedAt: approval.approvedAt,
                clientSignatureUrl: approval.clientSignatureUrl,
            },
        });
        return { co, transitioned: true };
    }, { timeout: 15_000 });
}

/**
 * Session-free delete core. The permission-gated server action is the only
 * remote entry point; lifecycle and signature-audit checks remain in this
 * locked transaction.
 */
export async function deleteChangeOrderCore(id: string) {
    return prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{
            id: string;
            projectId: string;
            status: string;
            approvedBy: string | null;
            approvedAt: Date | null;
            clientSignatureUrl: string | null;
            companySignedBy: string | null;
            companySignedAt: Date | null;
            companySignatureUrl: string | null;
        }>>`
            SELECT "id", "projectId", "status",
                   "approvedBy", "approvedAt", "clientSignatureUrl",
                   "companySignedBy", "companySignedAt", "companySignatureUrl"
            FROM "ChangeOrder" WHERE "id" = ${id} FOR UPDATE`;
        const current = locked[0];
        if (!current) return null;
        const hasSignatureAudit = Boolean(
            current.approvedBy
            || current.approvedAt
            || current.clientSignatureUrl
            || current.companySignedBy
            || current.companySignedAt
            || current.companySignatureUrl,
        );
        if (current.status !== "Draft" || hasSignatureAudit) {
            throw new Error("Only unsigned Draft change orders can be deleted. Sent and signed records must remain in the audit trail.");
        }
        await tx.changeOrder.delete({ where: { id } });
        return current;
    }, { timeout: 15_000 });
}
