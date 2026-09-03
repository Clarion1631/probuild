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
import { randomUUID } from "node:crypto";
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
    /**
     * `opts.upsert` is passed through to the signer. Only THIS module ever
     * asks for it (see below), so every other issuer gets a create-only token.
     */
    sign: (storagePath: string, opts: { upsert: boolean }) => Promise<SignedUpload | null>;
    /** When a freshly issued URL stops working. */
    expiresAt: () => Date;
    now?: () => number;
    /**
     * The adoption generation written on every lease issue or extension. A
     * fresh, unguessable value each call — see `newLeaseNonce`.
     */
    nonce?: () => string;
}

/**
 * The value `uploadLeaseNonce` carries, and the reason it is random rather than
 * a counter.
 *
 * A counter would have to be READ before it could be incremented, which is one
 * more thing for two concurrent adopters to agree about; a random value needs
 * no read at all and still gives the discard CAS the only property it wants —
 * "nobody else has written this column since I did". Uniqueness is the whole
 * contract; ordering is not.
 */
export function newLeaseNonce(): string {
    return randomUUID();
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
 *
 * THE ADOPTION IS ALSO STAMPED, with a fresh `uploadLeaseNonce`. That column is
 * what `discardUnresumedLease` pins, and it is written here rather than being
 * inferred from the expiry: an extension and an original issue both compute
 * "now + 2h", so the expiry can legitimately come out identical and the discard
 * would then delete the very row this call just adopted. The nonce is NOT part
 * of this CAS's where clause — two honest retries may both reuse the same live
 * lease over the same path, and turning that into a 409 would break the
 * idempotency this module exists to provide.
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
        data: {
            ...rearm,
            uploadUrlExpiresAt: deps.expiresAt(),
            uploadLeaseNonce: (deps.nonce ?? newLeaseNonce)(),
        },
    });
    if (count === 0) return { kind: "conflict" };

    // THE ONE PLACE AN UPSERT-CAPABLE TOKEN IS ISSUED.
    //
    // This is the reuse path: the path already exists as far as the client is
    // concerned, and the whole point is to let it replace a partial or
    // superseded upload of its own. Every other issuer signs a path a version
    // bump has just made new, so a create-only token is enough there and the
    // weaker capability is what they get (see createReceiptUploadUrl).
    const signed = await deps.sign(path, { upsert: true });
    return signed ? { kind: "signed", signed } : { kind: "storage-unavailable" };
}

/** The lease /start just created, as the request that created it knows it. */
export interface CreatedLease {
    id: string;
    storagePath: string;
    uploadLeaseVersion: number;
    uploadUrlExpiresAt: Date;
    /** The generation THIS request wrote. The discard below pins it exactly. */
    uploadLeaseNonce: string;
}

export interface DiscardClient {
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

/**
 * THROW AWAY A ROW WHOSE URL WAS NEVER ISSUED — BUT ONLY IF NOBODY RESUMED IT.
 *
 * /start creates the row FIRST and signs the upload URL SECOND, so a signer
 * failure leaves a STAGING row for an upload that will never happen and the
 * row has to go: it holds the sourceRef, and while it does, every honest retry
 * is answered about a lease its caller was never given.
 *
 * The delete used to be unconditional (`delete({ where: { id } })`), and that
 * is a race with the retry path this module exists for. A concurrent /start for
 * the same sourceRef hits the unique violation, finds this very row with a LIVE
 * lease, and reuseLiveLease hands it a working signed URL over the same path —
 * all of which can complete while the original request is still waiting on its
 * own failing signer. The unconditional delete then removed the row the retry
 * had just adopted: the retry's bytes landed at a path no row pointed at,
 * /finalize 404'd on an id that no longer existed, and the sourceRef's
 * protection against a DIFFERENT document reusing it was gone with it.
 *
 * So the delete is a CAS over the lease THIS request wrote. Every way another
 * request can adopt the row writes `uploadLeaseNonce`, and each also moves one
 * of the other pinned columns:
 *   - reuseLiveLease extends `uploadUrlExpiresAt` (same path, same version)
 *   - the resume branch bumps `uploadLeaseVersion` and repaths `storagePath`
 *   - anything that publishes or parks it moves `state` off STAGING
 *
 * THE EXPIRY IS NOT ENOUGH ON ITS OWN, which is what the previous round got
 * wrong. It reasoned that a retry can only reach the reuse AFTER this INSERT
 * committed, so its `expiresAt()` must read strictly later than ours. That is
 * an argument about ORDER, and this CAS needs INEQUALITY: production issues
 * both the initial and the resumed expiry as "now + 2h", `Date.now()` has
 * millisecond resolution, and two requests a few hundred microseconds apart —
 * or on two hosts whose clocks are merely close — write the SAME instant. The
 * pin then matched, the row another request had just adopted was deleted, its
 * bytes landed at a path nothing pointed at, and /finalize 404'd.
 *
 * `uploadLeaseNonce` closes that: it is a fresh random value on every issue and
 * every adoption, so "nobody wrote this column after I did" is a property of
 * the value itself rather than of a clock. The other three columns stay in the
 * fence — they are cheap, and each one independently rules out a class of
 * adopter.
 *
 * `resumed` is not an error: somebody else owns this row and their URL works.
 * The caller answers the idempotent conflict rather than reporting a failure
 * for a row that is alive and in good hands.
 */
export async function discardUnresumedLease(
    created: CreatedLease,
    db: DiscardClient,
): Promise<"discarded" | "resumed"> {
    const { count } = await db.deleteMany({
        where: {
            id: created.id,
            state: "STAGING",
            storagePath: created.storagePath,
            uploadLeaseVersion: created.uploadLeaseVersion,
            uploadUrlExpiresAt: created.uploadUrlExpiresAt,
            uploadLeaseNonce: created.uploadLeaseNonce,
        },
    });
    return count > 0 ? "discarded" : "resumed";
}
