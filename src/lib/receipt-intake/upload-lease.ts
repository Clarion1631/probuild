/**
 * ONE LEASE-REUSE RULE, FOR EVERY RESUMABLE STATE.
 *
 * A /start retry against a row whose upload lease has NOT expired must be
 * idempotent: the SAME path, the SAME lease version, nothing deleted. Every
 * other /start branch is destructive by design — it bumps the version, repaths
 * the row, and drops the previous object — and running that while a signed URL
 * is still live invalidates the ORIGINAL caller's URL and deletes the object it
 * is about to PUT its bytes to. Two /start calls for one sourceRef (a network
 * retry, a double-tap, a forwarder's own retry policy) are exactly that race.
 *
 * `createSignedUploadUrl` does not revoke a previously issued token when called
 * again for the SAME path, so an unexpired lease can safely be handed a fresh
 * signed URL over its existing object identity.
 *
 * An earlier round fixed this for STAGING rows ONLY, which left the recoverable
 * NEEDS_REVIEW re-arm (file-missing / sha-mismatch) destructive on every retry:
 * a parked row that a forwarder retried twice still had its live path deleted
 * out from under the first attempt. The rule does not depend on the state, so
 * neither does this module — both /start branches go through it.
 */
import { publishFence, uploadPathFor, type ObservedRow } from "./stored-object";

export interface LeaseRow extends ObservedRow {
    id: string;
    storagePath: string;
    /** Null on rows that never had a signed URL (the single-shot path). */
    uploadUrlExpiresAt: Date | null;
}

export interface SignedUpload {
    uploadUrl: string;
    token: string;
    storagePath: string;
}

export interface LeaseClient {
    updateMany(args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
    }): Promise<{ count: number }>;
}

export interface LeaseDeps {
    db: LeaseClient;
    sign: (storagePath: string) => Promise<SignedUpload | null>;
    /** When a freshly issued URL stops working. */
    expiresAt: () => Date;
    now?: () => number;
}

export type LeaseReuse =
    | { kind: "signed"; signed: SignedUpload }
    | { kind: "storage-unavailable" }
    | { kind: "conflict" };

/**
 * Is there a live lease this request may reuse, and at what path?
 *
 * Null means "take a new lease" and covers three cases:
 *   - no lease was ever issued (`uploadUrlExpiresAt` null)
 *   - the lease expired — fair game to invalidate, nothing live relies on it
 *   - the row's path is not the one THIS request's extension names. The path is
 *     derived from (id, leaseVersion, ext), so a caller that changed its
 *     declared type has to take a new lease; reusing would leave the row
 *     pointing at an object whose name disagrees with its type.
 */
export function liveLeasePath(row: LeaseRow, ext: string, now: number = Date.now()): string | null {
    if (!row.uploadUrlExpiresAt || row.uploadUrlExpiresAt.getTime() <= now) return null;
    const named = uploadPathFor(row.id, row.uploadLeaseVersion, ext);
    return named === row.storagePath ? named : null;
}

/**
 * Extend a live lease and reissue a URL for its EXISTING path.
 *
 * `rearm` carries the identity writes a recovery needs (a corrected
 * `expectedSha256`, a cleared `fileSha256`), because a recoverable park may
 * legitimately come back with a different hash — they simply land on the same
 * path and the same lease version instead of on a new one.
 *
 * The DB lease moves with the URL it reissues. A resigned URL is good for a
 * fresh window; leaving `uploadUrlExpiresAt` at the ORIGINAL, older value let
 * the sweeper judge the lease dead and reclaim a row whose client was still
 * holding a perfectly live URL.
 *
 * A lost CAS is reported as `conflict`, never a fall-through to the destructive
 * branch: we know a live lease existed a moment ago, so re-pathing and deleting
 * on the strength of a row that just moved is precisely what this prevents. The
 * client retries and reads whatever the winner left.
 */
export async function reuseLiveLease(
    row: LeaseRow,
    ext: string,
    deps: LeaseDeps,
    rearm: Record<string, unknown> = {},
): Promise<LeaseReuse | null> {
    const path = liveLeasePath(row, ext, deps.now ? deps.now() : Date.now());
    if (!path) return null;

    // Fenced on the identity this retry already proved AND on the publish
    // fence, so a row the worker claimed, or re-parked under a reason nobody
    // here looked at, is not quietly re-armed.
    const { count } = await deps.db.updateMany({
        where: { id: row.id, storagePath: row.storagePath, ...publishFence(row) },
        data: { ...rearm, uploadUrlExpiresAt: deps.expiresAt() },
    });
    if (count === 0) return { kind: "conflict" };

    const signed = await deps.sign(path);
    return signed ? { kind: "signed", signed } : { kind: "storage-unavailable" };
}
