// Who may change WHAT about a user account.
//
// Every user-mutating surface had its own idea of this, and three of them had
// none at all. /api/users/[id] let any MANAGER write an arbitrary `role` and
// `status` and upsert an arbitrary permission set; /api/users accepted an
// arbitrary role on create and on PATCH. So a manager could promote themselves
// to ADMIN, grant themselves every permission, or disable and demote the real
// admins — which nullifies every authorization boundary above it, including the
// payroll one this branch is built on (round 9, finding 1).
//
// The mobile manager endpoint already had the right rules. They live here now,
// once, and every writer calls this.

import { ADMIN_ROLES } from "./access-rules";
import { canActOnFinancials } from "./financial-access";
import { isPayrollEligibleRole } from "./payroll-config";

/** The roles a User row may hold. Same set the schema documents and the manager endpoint validated. */
export const USER_ROLES = ["ADMIN", "MANAGER", "FIELD_CREW", "FINANCE", "CLIENT"] as const;

/** Roles an admin screen may ASSIGN. CLIENT is created by the portal invite flow, never chosen in the team editor. */
export const ASSIGNABLE_USER_ROLES = ["ADMIN", "MANAGER", "FIELD_CREW", "FINANCE"] as const;

export const USER_STATUSES = ["PENDING", "ACTIVATED", "DISABLED"] as const;

/** Every permission key the team editor may write. Mirrors the UserPermission columns. */
export const ASSIGNABLE_PERMISSIONS = [
    "manageTeamMembers", "manageSubs", "manageVendors", "companySettings",
    "costCodesCategories", "schedules", "estimates", "invoices", "contracts",
    "roomDesigner", "changeOrders", "financialReports", "timeClock",
    "dailyLogs", "files", "takeoffs", "autoGrantNewProjects",
] as const;

/**
 * The permissions that confer AUTHORITY rather than access to a document.
 *
 * Only an ADMIN may grant or revoke these:
 *   financialReports  — the gate on payroll, pay rates and the Gusto export;
 *   manageTeamMembers — user management, i.e. the ability to grant the rest;
 *   companySettings   — org configuration, including the integration
 *                       credentials the money rails authenticate with.
 *
 * Deliberately NOT every permission. A manager granting a crew member
 * `schedules` or `files` is delegating something they already hold and is
 * ordinary work; a manager granting anybody the three above is changing who can
 * change the company.
 */
export const PRIVILEGED_PERMISSIONS = ["financialReports", "manageTeamMembers", "companySettings"] as const;

export type UserMutationActor = { id: string; role: string };
export type UserMutationTarget = { id: string; role: string };

export type UserMutationChanges = {
    role?: unknown;
    status?: unknown;
    /** The sanitized permission patch, or null/undefined when the request does not touch permissions. */
    permissions?: Record<string, unknown> | null;
};

export type UserMutationVerdict =
    | { ok: true }
    | { ok: false; status: 400 | 403; error: string };

const has = (list: readonly string[], value: unknown) => typeof value === "string" && list.includes(value);

/**
 * THE decision. Pure, so every route and action can share it and it can be
 * tested exhaustively without a database.
 *
 * `target` is the row being written, re-read by the caller — never the values
 * from the request body, which is what the caller is trying to change.
 *
 * Order matters: shape (400) before authority (403), so a caller is told their
 * enum is wrong rather than that they are forbidden from sending nonsense.
 */
export function checkUserMutation(input: {
    actor: UserMutationActor;
    target: UserMutationTarget;
    changes: UserMutationChanges;
}): UserMutationVerdict {
    const { actor, target, changes } = input;
    const wantsRole = changes.role !== undefined;
    const wantsStatus = changes.status !== undefined;
    const permissionKeys = changes.permissions ? Object.keys(changes.permissions) : [];

    // ---- shape ------------------------------------------------------------
    if (wantsRole && !has(ASSIGNABLE_USER_ROLES, changes.role)) {
        return { ok: false, status: 400, error: `Invalid role: ${String(changes.role)}` };
    }
    if (wantsStatus && !has(USER_STATUSES, changes.status)) {
        return { ok: false, status: 400, error: `Invalid status: ${String(changes.status)}` };
    }
    for (const key of permissionKeys) {
        if (!(ASSIGNABLE_PERMISSIONS as readonly string[]).includes(key)) {
            return { ok: false, status: 400, error: `Unknown permission: ${key}` };
        }
    }

    // ---- the TARGET has to be able to hold what is being granted ----------
    //
    // A privileged permission on a portal CLIENT is not a permission, it is a
    // customer with the keys to payroll and the integration credentials. Round
    // 15 made every gate on that surface require a staff role as well as the
    // permission, which closes it at the READING end; this closes it at the
    // GRANTING end, so the row cannot exist in the first place.
    //
    // Before authority, with the other shape checks: an ADMIN doing this is
    // making a mistake, not exceeding their authority, and telling them so is
    // more useful than a 403.
    if (!isPayrollEligibleRole(target.role)) {
        const privilegedForNonStaff = permissionKeys.filter((key) =>
            (PRIVILEGED_PERMISSIONS as readonly string[]).includes(key)
        );
        if (privilegedForNonStaff.length > 0) {
            return {
                ok: false,
                status: 400,
                error: `A ${target.role.toLowerCase()} account cannot hold ${privilegedForNonStaff.join(", ")} — those grant access to payroll, company settings and the integration credentials.`,
            };
        }
    }

    // ---- authority --------------------------------------------------------
    if (!ADMIN_ROLES.includes(actor.role)) {
        return { ok: false, status: 403, error: "Only managers and admins can change a team member." };
    }
    if (actor.role === "ADMIN") return { ok: true };

    // Everything below is a MANAGER.
    if (target.role === "ADMIN") {
        return { ok: false, status: 403, error: "Only an admin can modify an admin account." };
    }
    if (wantsRole) {
        return { ok: false, status: 403, error: "Only an admin can change a team member's role." };
    }
    if (target.id === actor.id) {
        if (wantsStatus) {
            return { ok: false, status: 403, error: "You cannot change your own status." };
        }
        if (permissionKeys.length > 0) {
            return { ok: false, status: 403, error: "You cannot change your own permissions." };
        }
    }
    const privileged = permissionKeys.filter((key) =>
        (PRIVILEGED_PERMISSIONS as readonly string[]).includes(key)
    );
    if (privileged.length > 0) {
        return {
            ok: false,
            status: 403,
            error: `Only an admin can grant or revoke ${privileged.join(", ")}.`,
        };
    }
    return { ok: true };
}

/**
 * The same decision for a CREATE, where there is no target row yet.
 *
 * A create cannot demote anybody, so the only question is whether the caller may
 * mint the role they asked for. Status is not a parameter: every create path
 * starts a row at PENDING.
 */
export function checkUserCreate(input: { actor: UserMutationActor; role: unknown }): UserMutationVerdict {
    if (input.role !== undefined && !has(ASSIGNABLE_USER_ROLES, input.role)) {
        return { ok: false, status: 400, error: `Invalid role: ${String(input.role)}` };
    }
    if (!ADMIN_ROLES.includes(input.actor.role)) {
        return { ok: false, status: 403, error: "Only managers and admins can add a team member." };
    }
    if (input.role === "ADMIN" && input.actor.role !== "ADMIN") {
        return { ok: false, status: 403, error: "Only an admin can create an admin account." };
    }
    return { ok: true };
}

/**
 * THE target-role race (round 12, finding 2).
 *
 * PUT/PATCH /api/users/[id], PATCH /api/users and PATCH
 * /api/manager/employees/[id] all authorized against a `User.role` read taken
 * BEFORE the write transaction opened, then updated/deleted without checking
 * again. An admin promotion committing in the gap between that read and the
 * write let a manager's already-in-flight request — authorized against a crew
 * member — act on the now-admin account: the row it was authorized against was
 * not the row it wrote.
 *
 * Minimal database surface — just enough to take a row lock: no PayrollTxClient
 * import needed here to avoid a public dependency on that module's shape.
 */
export type GuardedUserMutationClient = {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
};

/**
 * Thrown when the LOCKED row fails checkUserMutation. Carries the verdict so a
 * catch block can answer with the exact status/message checkUserMutation would
 * have returned directly — the caller-facing contract does not change, only
 * when the check runs.
 */
export class UserMutationRefusedError extends Error {
    readonly verdict: Extract<UserMutationVerdict, { ok: false }>;
    constructor(verdict: Extract<UserMutationVerdict, { ok: false }>) {
        super(verdict.error);
        this.name = "UserMutationRefusedError";
        this.verdict = verdict;
    }
}

export function isUserMutationRefusedError(error: unknown): error is UserMutationRefusedError {
    return error instanceof Error && error.name === "UserMutationRefusedError";
}

/** Thrown when the target row does not exist under the lock. */
export class UserMutationTargetNotFoundError extends Error {
    readonly targetId: string;
    constructor(targetId: string) {
        super(`User not found: ${targetId}`);
        this.name = "UserMutationTargetNotFoundError";
        this.targetId = targetId;
    }
}

export function isUserMutationTargetNotFoundError(error: unknown): error is UserMutationTargetNotFoundError {
    return error instanceof Error && error.name === "UserMutationTargetNotFoundError";
}

/** Thrown when the ACTOR's own row cannot authorize this write, under the lock. */
export class UserMutationActorInvalidError extends Error {
    readonly verdict: Extract<UserMutationVerdict, { ok: false }>;
    constructor(verdict: Extract<UserMutationVerdict, { ok: false }>) {
        super(verdict.error);
        this.name = "UserMutationActorInvalidError";
        this.verdict = verdict;
    }
}

export function isUserMutationActorInvalidError(error: unknown): error is UserMutationActorInvalidError {
    return error instanceof Error && error.name === "UserMutationActorInvalidError";
}

/**
 * The actor as the TRANSACTION sees them: role, status and permissions read
 * under the lock, not off the session-time query the route ran before it opened
 * a transaction.
 *
 * Shaped so it can be passed straight to `hasPermission` and to the rate
 * writer's `canWriteRates`, because those are the two places a stale permission
 * set did real damage.
 */
export type LockedUserActor = {
    id: string;
    role: string;
    status: string;
    permissions: Record<string, unknown> | null;
};

/** One row's worth of the two SELECTs below. */
type LockedUserRow = { id: string; role: string; status: string };

/**
 * Lock and re-read the actor and the target, in ASCENDING ID ORDER.
 *
 * The order is the whole point of doing it here rather than at each call site.
 * Two managers editing each other at the same moment take the same two rows in
 * the same sequence, so they queue instead of closing a cycle. When the actor
 * IS the target — a manager editing themselves — there is one row and one lock,
 * taken in the stronger mode.
 *
 * The target is locked FOR UPDATE (it is about to be written). The actor is
 * locked FOR SHARE: this transaction only READS their authority, and FOR SHARE
 * is enough to hold off the UPDATE that would demote, disable or re-permission
 * them — every one of which goes through this same guard and therefore takes
 * FOR UPDATE on that row.
 */
/** How strongly one User row is being taken. FOR UPDATE is the stronger of the two. */
export type UserRowLockMode = "FOR UPDATE" | "FOR SHARE";

/** One row this transaction wants held while it decides or writes. */
export type UserRowLockRequest = { id: string; mode: UserRowLockMode };

/**
 * THE only place User row locks are issued — so tier 2 of the global lock order
 * (src/lib/payroll-period.ts) is decided once rather than per call site.
 *
 * ASCENDING ID, always, and the STRONGEST mode asked for a row that is named
 * twice. Two transactions touching the same rows therefore queue instead of
 * closing a cycle, and a transaction that will WRITE a row cannot end up
 * holding it merely FOR SHARE because something else asked for the weaker lock
 * first.
 *
 * Ordered by code unit (`Array.prototype.sort`), which is the comparison the
 * actor/target pair has always used. Every caller has to use THIS function, not
 * its own sort: `localeCompare` and `<` are not the same order, and two payroll
 * paths ordering the same two ids differently is precisely the cycle the
 * ordering exists to prevent.
 */
async function lockUserRowsAscending(
    tx: GuardedUserMutationClient,
    requests: readonly UserRowLockRequest[]
): Promise<Map<string, LockedUserRow>> {
    const strongest = new Map<string, UserRowLockMode>();
    for (const request of requests) {
        if (!request?.id) continue;
        if (strongest.get(request.id) === "FOR UPDATE") continue;
        strongest.set(request.id, request.mode);
    }

    const select = `SELECT "id", "role", "status" FROM "User" WHERE "id" = $1`;
    const locked = new Map<string, LockedUserRow>();
    for (const id of [...strongest.keys()].sort()) {
        const rows = (await tx.$queryRawUnsafe(`${select} ${strongest.get(id)}`, id)) as LockedUserRow[];
        if (rows[0]) locked.set(id, rows[0]);
    }
    return locked;
}

async function lockActorAndTarget(
    tx: GuardedUserMutationClient,
    actorId: string,
    targetId: string | null
): Promise<{ actor: LockedUserRow | null; target: LockedUserRow | null }> {
    if (targetId === null || targetId === actorId) {
        // ONE row. FOR UPDATE, because when they are the same row this
        // transaction may be writing it.
        const locked = await lockUserRowsAscending(tx, [{ id: actorId, mode: "FOR UPDATE" }]);
        const row = locked.get(actorId) ?? null;
        return { actor: row, target: targetId === null ? null : row };
    }

    const locked = await lockUserRowsAscending(tx, [
        { id: actorId, mode: "FOR SHARE" },
        { id: targetId, mode: "FOR UPDATE" },
    ]);
    return { actor: locked.get(actorId) ?? null, target: locked.get(targetId) ?? null };
}

/** The actor's permission row, read inside the transaction under their FOR SHARE. */
async function readActorPermissions(
    tx: GuardedUserMutationClient,
    actorId: string
): Promise<Record<string, unknown> | null> {
    const rows = (await tx.$queryRawUnsafe(
        `SELECT * FROM "UserPermission" WHERE "userId" = $1`,
        actorId
    )) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
}

/**
 * Is this actor, as the transaction now sees them, allowed to act at all?
 *
 * Deliberately separate from checkUserMutation: that answers "may this actor do
 * THIS to THAT row", and it never asked whether the actor still exists or is
 * still enabled. Nothing did — a DISABLED account's in-flight request went
 * through, because disabling somebody writes their row and every reader had
 * already read it.
 */
export function checkActorUsable(actor: LockedUserRow | null): UserMutationVerdict {
    if (!actor) {
        return { ok: false, status: 403, error: "Your account no longer exists." };
    }
    // POSITIVE: the account must BE activated, not merely "not disabled".
    //
    // The denylist version let a PENDING account through (round 16,
    // finding 3) — an invited-but-never-activated row, which is exactly what
    // every create in this app produces, and what an admin revoking access by
    // resetting somebody to PENDING would produce too. USER_STATUSES has three
    // members and only one of them means "may act"; naming the other two is
    // how the third one gets forgotten.
    if (actor.status !== "ACTIVATED") {
        return {
            ok: false,
            status: 403,
            error:
                actor.status === "DISABLED"
                    ? "Your account has been disabled."
                    : "Your account is not activated.",
        };
    }
    return { ok: true };
}

/**
 * The refusal a payroll write gives when the ACTOR lost financial access while
 * the write was queued. Named once so the actions, the tests and the UI cannot
 * drift on it.
 */
export const PAYROLL_ACTOR_REVOKED =
    "Your account no longer has payroll access. Nothing was changed.";

/** The same, for the two ADMIN-only period actions (discard, unlock). */
export const PAYROLL_ACTOR_NOT_ADMIN =
    "Only an admin can do this, and your account is no longer one. Nothing was changed.";

/**
 * THE in-transaction re-authorization for a payroll write (round 21, P1).
 *
 * Every payroll mutation authorized its caller with `requirePayrollAccess()`
 * BEFORE it opened a transaction, and then waited — on the payroll advisory
 * lock, on User rows, on TimeEntry rows. An account disabled, demoted, or
 * stripped of `financialReports` while that request sat in the queue still
 * committed, with authority it no longer had. It is exactly the round-14 actor
 * race that `withGuardedUserMutation` closed for the team editor, on the other
 * family of writers — so it is closed the same way, by the same mechanism,
 * rather than by a second one:
 *
 *   1. the caller takes the PAYROLL ADVISORY LOCK first (tier 1). This function
 *      deliberately does not take it — a payroll writer's own lock mode
 *      (shared for a writer, exclusive for lock creation) is the caller's
 *      decision, and taking a second one here would put tier 1 after tier 2 for
 *      any caller that already held it;
 *   2. this locks the actor's row FOR SHARE — enough to hold off the UPDATE
 *      that would demote, disable or re-permission them, because every one of
 *      those goes through withGuardedUserMutation and therefore takes FOR
 *      UPDATE on that row — TOGETHER WITH the rows the caller is about to
 *      write, in one ascending-id sequence (`alsoLock`). Passing them here
 *      rather than locking them separately is what keeps the order true: two
 *      User rows taken in two different orders by two payroll paths is a cycle;
 *   3. `checkActorUsable` (the account still exists and is ACTIVATED), then
 *      `canActOnFinancials` on what the lock actually holds — the SAME
 *      predicate requirePayrollAccess, the export endpoint, the roster endpoint
 *      and the rates panel compose, so a revoked actor is refused by the same
 *      rule that would have refused them at the door.
 *
 * Throws `UserMutationActorInvalidError`, the branch's typed refusal for
 * exactly this, so a caller inside `try/catch` answers with its message and a
 * caller without one fails the way `requirePayrollAccess()` already does.
 *
 * Returns the LOCKED actor. Hand THAT to anything downstream that asks an
 * authority question; never the action's pre-transaction copy.
 */
export async function requireFinancialActorInTx(
    tx: GuardedUserMutationClient,
    actorId: string,
    options: {
        /** Rows this transaction is about to write, folded into the one ordered lock. */
        alsoLock?: readonly UserRowLockRequest[];
        /** For the two ADMIN-only period actions — `canActOnFinancials` admits a MANAGER. */
        requireAdmin?: boolean;
    } = {}
): Promise<LockedUserActor> {
    const locked = await lockUserRowsAscending(tx, [
        { id: actorId, mode: "FOR SHARE" },
        ...(options.alsoLock ?? []),
    ]);
    const row = locked.get(actorId) ?? null;

    const usable = checkActorUsable(row);
    if (!usable.ok) throw new UserMutationActorInvalidError(usable);

    const actor: LockedUserActor = {
        id: row!.id,
        role: row!.role,
        status: row!.status,
        permissions: await readActorPermissions(tx, actorId),
    };

    if (!canActOnFinancials(actor)) {
        throw new UserMutationActorInvalidError({ ok: false, status: 403, error: PAYROLL_ACTOR_REVOKED });
    }
    if (options.requireAdmin && actor.role !== "ADMIN") {
        throw new UserMutationActorInvalidError({ ok: false, status: 403, error: PAYROLL_ACTOR_NOT_ADMIN });
    }
    return actor;
}

/**
 * THE entry point for every write that changes an EXISTING User's role,
 * status, permissions, pinCode, or that deletes the row.
 *
 * Order, inside the caller's transaction:
 *   1. If ANY PART of this request will take the payroll advisory lock, take it
 *      HERE, first — the tier-1 lock, before any row lock, same rule
 *      withPayrollUserWrite already applies, kept here so a caller does not
 *      have to remember to call both.
 *
 *      "Any part" is the whole request, not just `data`: the rate fields travel
 *      SEPARATELY to applyRateChangeInTx, which takes the same lock itself. This
 *      used to ask only about `data`, so a rate-only edit (whose `data` names no
 *      export column at all) fell through to the row lock below and THEN waited
 *      for the payroll lock inside the rate writer — while lockPayrollPeriod
 *      held that lock and waited FOR SHARE on the very row this transaction was
 *      holding. A textbook inversion, and a real deadlock (round 13, finding 1).
 *      `takesPayrollWriteLock` answers for both halves at once, so tier 1 is
 *      always taken before tier 2.
 *   2. Lock and re-read BOTH the actor and the target, in ascending id order.
 *
 *      The target half closed the round-12 hole: a promotion committing between
 *      a pre-transaction role read and the write let a request authorized
 *      against a crew member act on an admin. The ACTOR half is the same bug
 *      pointed the other way, and it survived that fix (round 14, finding 3):
 *      role, status and permissions were still taken from a query the route ran
 *      BEFORE it opened a transaction, so a manager demoted, disabled or
 *      stripped of `financialReports` a millisecond earlier still wrote — with
 *      the authority they no longer had, and (through `canWriteRates`) still
 *      set pay rates.
 *   3. `checkActorUsable` on the locked actor, then `checkUserMutation` with the
 *      locked actor's role against the locked target's role.
 *   4. `write(target, actor)` — every affected column write belongs inside this
 *      closure, in the SAME transaction. `actor` is the LOCKED actor; hand it to
 *      anything downstream that asks an authority question (the rate writer
 *      does), never the route's pre-transaction copy.
 *
 * `data` is the raw payload about to be written to the row, or omitted for a
 * write with no column payload of its own (DELETE). `rateChange` is the payload
 * the caller is about to hand applyRateChangeInTx, or omitted when it will not
 * call it. Together they decide ONLY whether the payroll lock is taken first —
 * never whether the row locks or the authority checks run, all of which are
 * unconditional.
 *
 * Pass the SAME rate object the closure hands to applyRateChangeInTx. Building
 * a second one here would be a second answer to "does this request write
 * rates", which is the shape of the bug that parameter exists to fix.
 *
 * `actorId` is an ID and nothing else, on purpose: there is no field on it for
 * a caller to pass a stale role in.
 */
export async function withGuardedUserMutation<T>(
    tx: GuardedUserMutationClient,
    input: {
        actorId: string;
        targetId: string;
        changes: UserMutationChanges;
        data?: unknown;
        rateChange?: unknown;
    },
    write: (target: UserMutationTarget, actor: LockedUserActor) => Promise<T>
): Promise<T> {
    const { takesPayrollWriteLock, acquirePayrollWriteLock } = await import("./payroll-period");
    // TIER 1, unconditionally before the row locks below when it is needed at
    // all — never after them, and never decided from half the request.
    if (takesPayrollWriteLock({ data: input.data, rateChange: input.rateChange })) {
        await acquirePayrollWriteLock(tx);
    }

    const locked = await lockActorAndTarget(tx, input.actorId, input.targetId);

    const usable = checkActorUsable(locked.actor);
    if (!usable.ok) throw new UserMutationActorInvalidError(usable);
    if (!locked.target) throw new UserMutationTargetNotFoundError(input.targetId);

    const actor: LockedUserActor = {
        id: locked.actor!.id,
        role: locked.actor!.role,
        status: locked.actor!.status,
        permissions: await readActorPermissions(tx, input.actorId),
    };
    const target: UserMutationTarget = { id: input.targetId, role: locked.target.role };

    const verdict = checkUserMutation({ actor: { id: actor.id, role: actor.role }, target, changes: input.changes });
    if (!verdict.ok) throw new UserMutationRefusedError(verdict);

    return write(target, actor);
}

/**
 * The same protocol for a CREATE, where there is no target row yet.
 *
 * Creation used to sit outside the guard entirely: `checkUserCreate` ran against
 * the route's pre-transaction actor read and the insert happened afterwards, so
 * a manager demoted or disabled in between still minted an account — and then
 * set its pay rates through the same stale actor (round 14, finding 3).
 *
 * There is one row to lock, the actor's, and it is locked FOR SHARE for the same
 * reason as above: this transaction reads their authority, and every write that
 * would change it takes FOR UPDATE on that row through the guard.
 */
export async function withGuardedUserCreate<T>(
    tx: GuardedUserMutationClient,
    input: { actorId: string; role: unknown },
    write: (actor: LockedUserActor) => Promise<T>
): Promise<T> {
    const rows = (await tx.$queryRawUnsafe(
        `SELECT "id", "role", "status" FROM "User" WHERE "id" = $1 FOR SHARE`,
        input.actorId
    )) as LockedUserRow[];
    const row = rows[0] ?? null;

    const usable = checkActorUsable(row);
    if (!usable.ok) throw new UserMutationActorInvalidError(usable);

    const actor: LockedUserActor = {
        id: row!.id,
        role: row!.role,
        status: row!.status,
        permissions: await readActorPermissions(tx, input.actorId),
    };

    const verdict = checkUserCreate({ actor: { id: actor.id, role: actor.role }, role: input.role });
    if (!verdict.ok) throw new UserMutationRefusedError(verdict);

    return write(actor);
}
