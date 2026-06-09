import { Prisma } from "@prisma/client";

/**
 * Auto soft-delete read filter (recovery net — see SOFT_DELETE.md).
 *
 * A Prisma Client extension that injects `where: { deletedAt: null }` into every
 * read on the covered models, so soft-deleted rows are invisible to ordinary
 * queries WITHOUT hand-editing each call site. Applied in src/lib/prisma.ts.
 *
 * ESCAPE HATCHES (to read soft-deleted rows — used by the delete/restore actions
 * and the admin Trash/Audit UI):
 *   1. Use `prismaBase` (the un-extended client exported from src/lib/prisma.ts).
 *   2. Pass an explicit `deletedAt` constraint in the `where` (e.g.
 *      `{ where: { deletedAt: { not: null } } }`) — the extension detects that the
 *      caller already constrains `deletedAt` and skips injection.
 *
 * LIMITATION: Prisma client extensions only intercept TOP-LEVEL operations, not
 * nested relation reads (`include`/`select` of a relation). The cascade rules are
 * designed so soft-deleted children almost always sit under a soft-deleted (hidden)
 * parent. The two exceptions — an Estimate deleted under a live Lead/Project, and a
 * Lead/Project deleted under a live Client — are handled by adding an explicit
 * `where: { deletedAt: null }` to those specific relation includes.
 *
 * findUnique/findUniqueOrThrow: relies on `extendedWhereUnique` (GA since Prisma 5)
 * which permits the non-unique `deletedAt` filter alongside the unique selector.
 */

/** Models covered by the soft-delete safety net (Prisma delegate names). */
export const SOFT_DELETE_MODELS = [
    "client",
    "lead",
    "project",
    "estimate",
    "estimateItem",
    "estimatePaymentSchedule",
] as const;

/** Read operations that must hide soft-deleted rows. */
const READ_OPERATIONS = [
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "findUnique",
    "findUniqueOrThrow",
    "count",
    "aggregate",
    "groupBy",
] as const;

/** Inject `deletedAt: null` unless the caller already constrains `deletedAt`. */
function injectNotDeleted(args: any) {
    const next = args ? { ...args } : {};
    const where = next.where ?? {};
    // Escape hatch: respect an explicit, DEFINED deletedAt constraint (e.g. reading the
    // trash with `{ deletedAt: { not: null } }`). We deliberately check `!== undefined`
    // rather than key presence so a spread-in `deletedAt: undefined` (which Prisma
    // ignores) can't silently disable the soft-delete filter.
    if (where.deletedAt !== undefined) {
        return next;
    }
    next.where = { ...where, deletedAt: null };
    return next;
}

/** Build the per-model map of intercepted read operations. */
function buildModelOps() {
    const ops: Record<string, (params: any) => any> = {};
    for (const operation of READ_OPERATIONS) {
        ops[operation] = ({ args, query }: { args: any; query: (a: any) => any }) =>
            query(injectNotDeleted(args));
    }
    return ops;
}

const modelOps = buildModelOps();

export const softDeleteExtension = Prisma.defineExtension({
    name: "soft-delete-filter",
    query: {
        client: modelOps,
        lead: modelOps,
        project: modelOps,
        estimate: modelOps,
        estimateItem: modelOps,
        estimatePaymentSchedule: modelOps,
    } as any,
});
