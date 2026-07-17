import { prisma } from "./prisma";
import { coLineCents } from "./co-tax";

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

export type ChangeOrderUpdateInput = {
    title?: string;
    description?: string | null;
    status?: unknown;
    items?: ChangeOrderItemInput[] | unknown;
    [key: string]: unknown;
};

function itemSubtotalCents(items: Array<{ quantity: number; unitCost: unknown }>): number {
    return items.reduce((sum, item) => sum + coLineCents(item.quantity, Number(item.unitCost)), 0);
}

/**
 * Session-free change-order persistence used by the permission-gated server
 * action. Keeping the transaction outside actions.ts lets money-path tests
 * exercise the real row locks and writes without exposing an auth-free server
 * action (only exports from a `"use server"` module are remotely invokable).
 */
export async function updateChangeOrderCore(id: string, data: ChangeOrderUpdateInput) {
    const items = Array.isArray(data.items) ? data.items as ChangeOrderItemInput[] : undefined;

    return prisma.$transaction(async (tx) => {
        // Serialize editors with send, approval, billing, and co-audit repair.
        const locked = await tx.$queryRaw<Array<{
            status: string;
            title: string;
            description: string | null;
            totalAmount: unknown;
            approvedBy: string | null;
            approvedAt: Date | null;
            clientSignatureUrl: string | null;
            companySignedBy: string | null;
            companySignedAt: Date | null;
            companySignatureUrl: string | null;
        }>>`
            SELECT "status", "title", "description", "totalAmount",
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
        const hasScopeWrite = ["title", "description", "items"].some((field) => Object.prototype.hasOwnProperty.call(data, field));
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

            let totalCents = 0;
            const rows = items.map((item, idx) => {
                const quantity = parseFloat(String(item.quantity ?? "")) || 0;
                const unitCost = parseFloat(String(item.unitCost ?? "")) || 0;
                const unitCents = Math.round(unitCost * 100);
                const lineCents = coLineCents(quantity, unitCost);
                totalCents += lineCents;
                return {
                    id: item.id || undefined,
                    name: item.name || "",
                    description: item.description || null,
                    ...(item.type ? { type: item.type } : {}),
                    quantity,
                    unitCost: unitCents / 100,
                    total: lineCents / 100,
                    order: item.order ?? idx,
                    costCodeId: item.costCodeId || null,
                    costTypeId: item.costTypeId || null,
                };
            });

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
        const locked = await tx.$queryRaw<Array<{ id: string; code: string; status: string; totalAmount: unknown }>>`
            SELECT "id", "code", "status", "totalAmount"
            FROM "ChangeOrder" WHERE "id" = ${id} FOR UPDATE`;
        const current = locked[0];
        if (!current) return null;

        if (current.status !== "Sent") {
            throw new Error(`Change order ${current.code} must be Sent before it can be approved.`);
        }

        if (!approval.signatureName.trim() || !approval.clientSignatureUrl) {
            throw new Error("A client name and persisted signature is required to approve a change order.");
        }

        const items = await tx.changeOrderItem.findMany({
            where: { changeOrderId: id },
            select: { quantity: true, unitCost: true },
        });
        if (items.length === 0) {
            throw new Error(`Change order ${current.code} must contain at least one priced item before it can be approved.`);
        }

        const storedSubtotalCents = Math.round(Number(current.totalAmount) * 100);
        const renderedSubtotalCents = itemSubtotalCents(items);
        if (storedSubtotalCents <= 0 || renderedSubtotalCents <= 0) {
            throw new Error(`Change order ${current.code} must have a positive subtotal before it can be approved.`);
        }
        if (storedSubtotalCents !== renderedSubtotalCents) {
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
