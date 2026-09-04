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
import { leaseFence, uploadPathFor, type ObservedRow } from "./stored-object";

export interface LeaseRow extends ObservedRow {
    id: string;
    storagePath: string;
    /** Null on rows that never had a signed URL (the single-shot path). */
    uploadUrlExpiresAt: Date | null;
    /**
     * The hash the LIVE lease was issued for. Part of the lease's identity:
     * see reuseLiveLease. Empty on a row that never announced one.
     */
    expectedSha256?: string | null;
}

export interface SignedUpload {
    uploadUrl: string;
    token: string;
    storagePath: string;
}

/**
 * What /start hands back, and what /finalize demands to see again.
 *
 * `uploadLease` is the row's `uploadLeaseNonce` — an opaque, single-use-ish
 * generation stamp. It is returned so a finalizer can PROVE which lease its
 * signed URL was issued under. Without it /finalize read the row's CURRENT
 * nonce, so a delayed finalizer silently adopted whatever lease had been
 * issued since: two /start calls hand out URLs for the SAME path, and the
 * first client's stale finalize could then inspect a half-written object and
 * reject the row out from under the second client's perfectly live URL.
 *
 * Opaque by contract. It is a random UUID with no meaning outside the CAS —
 * not a capability (the signed URL is), and it grants nothing on its own.
 */
export interface IssuedLease extends SignedUpload {
    uploadLease: string;
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
    /**
     * Re-read the row. The adoption CAS is exclusive now, so a loser has to
     * see what actually won; and every issued lease is re-checked after the
     * signing round trip. Both need a fresh read, so it is a dependency
     * rather than something the caller does around this rule.
     */
    reload: (id: string) => Promise<LeaseRow | null>;
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

/**
 * A LIVE LEASE'S IDENTITY IS IMMUTABLE FOR ITS LIFETIME.
 *
 * Path, declared MIME (which the path's extension encodes) and announced
 * sha256 are fixed when the lease is issued. A retry that agrees with all
 * three may extend it; one that disagrees may not have it, because both
 * outcomes of allowing it are broken:
 *
 *   - a DIFFERENT extension made liveLeasePath refuse the path, and the
 *     caller then fell through to the destructive resume: a new version, a
 *     new path and a new generation, while the first caller's signed URL was
 *     still live and still pointed at the object that was about to be
 *     orphaned.
 *   - a DIFFERENT expectedSha256 was written straight through the extension,
 *     keeping the same generation, so two callers held ONE lease for two
 *     different documents and only whichever hash landed last could
 *     finalize.
 *
 * So it is a refusal, and it carries the live lease's expiry: the caller can
 * wait for it to lapse (after which the destructive branch is safe, because
 * nothing live relies on it any more) or start a separate intake.
 */
export type LeaseIdentityField = "mime" | "sha256";

export type LeaseReuse =
    | { kind: "signed"; signed: IssuedLease }
    | { kind: "storage-unavailable" }
    | { kind: "identity-conflict"; field: LeaseIdentityField; expiresAt: Date }
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
    if (!hasLiveLease(row, now)) return null;
    const named = uploadPathFor(row.id, row.uploadLeaseVersion, ext);
    return named === row.storagePath ? named : null;
}

/**
 * Is there a lease at all, whatever this request's extension says?
 *
 * liveLeasePath collapses two very different answers into null -- "nothing
 * live here, go take a new lease" and "there IS a live lease, but you are
 * asking about a different file type". The second is a refusal, not an
 * invitation to repath: the previous caller's URL still works.
 */
export function hasLiveLease(row: LeaseRow, now: number = Date.now()): boolean {
    return !!row.uploadUrlExpiresAt && row.uploadUrlExpiresAt.getTime() > now;
}

/**
 * Does this request agree with the live lease's announced hash?
 *
 * An empty stored value is adopted rather than compared -- a legacy row, or
 * one whose lease predates the field, has announced nothing to disagree with.
 */
export function sha256Agrees(row: LeaseRow, expectedSha256: string): boolean {
    const held = (row.expectedSha256 ?? "").toLowerCase();
    return !held || held === expectedSha256.toLowerCase();
}

/**
 * IS THIS THE SAME LEASE THE CALLER DECIDED ABOUT — only refreshed?
 *
 * A lost CAS may be re-tried, but ONLY against a row that is still the one the
 * caller looked at. /start decides whether a row is recoverable, and whether
 * its hash proves identity, from the row it read; a retry that silently
 * re-aimed at whatever is there now would re-arm a row that has since been
 * re-parked under a reason nobody here examined, or repathed to a new lease
 * whose object this request knows nothing about.
 *
 * So exactly two columns may move: `uploadLeaseNonce` and `uploadUrlExpiresAt`
 * — which is precisely the footprint of ANOTHER ADOPTER extending the same
 * live lease, the one case two honest retries are supposed to converge on.
 * Everything else is a conflict.
 */
function sameLease(decidedOn: LeaseRow, fresh: LeaseRow): boolean {
    return fresh.id === decidedOn.id
        && fresh.state === decidedOn.state
        && fresh.stateReason === decidedOn.stateReason
        && fresh.storagePath === decidedOn.storagePath
        && fresh.uploadLeaseVersion === decidedOn.uploadLeaseVersion;
}
/**
 * THE EXTENDED EXPIRY, GUARANTEED DIFFERENT FROM THE ONE IT REPLACES.
 *
 * `discardUnresumedLease` proves "nobody adopted the row I created" by pinning
 * the exact expiry it wrote. An adoption that extends a live lease over the
 * same path, at the same version and under the same generation, moves NOTHING
 * ELSE — so if it can also write the same instant, the discard's witness sees
 * nothing and deletes a row somebody is uploading to. Production computes both
 * expiries as "now + 2h": milliseconds apart, or on two hosts whose clocks are
 * merely close, they collide.
 *
 * So the adoption forces the difference instead of hoping for it: at least one
 * millisecond past what was there. It also never moves the expiry BACKWARDS,
 * which a skewed clock would otherwise do — shortening a lease whose holder is
 * still using a freshly signed URL is how the sweeper reclaims a live row.
 */
export function extendedExpiry(observed: Date | null, fresh: Date): Date {
    if (!observed) return fresh;
    return fresh.getTime() > observed.getTime() ? fresh : new Date(observed.getTime() + 1);
}

/**
 * How many times an adoption may lose its CAS and re-read before giving up.
 * Each loss means somebody else moved the row, so each retry starts from a
 * strictly newer observation; the bound is here to stop a pathological
 * hot-spot spinning inside one request, not because progress is in doubt.
 */
export const MAX_LEASE_ADOPTION_ATTEMPTS = 4;

/**
 * Extend a live lease and reissue a URL for its EXISTING path.
 *
 * `rearm` carries the identity writes a recovery needs (a corrected
 * `expectedSha256`, a cleared `fileSha256`), because a recoverable park may
 * legitimately come back with a different hash — they simply land on the same
 * path and the same lease version instead of on a new one.
 *
 * THE NONCE NAMES THE LEASE, NOT THE REQUEST — and that is the round-19 fix.
 *
 * This function used to mint a fresh `uploadLeaseNonce` on every adoption and
 * deliberately leave it OUT of its own CAS, so two concurrent /start retries
 * both matched, both wrote, and both returned a 200 carrying their own nonce.
 * Only the last write survived. /finalize demands the generation its URL was
 * issued under, so the earlier caller's perfectly good signed URL was answered
 * `409 lease-stale` for a lease it had been handed seconds before: an endpoint
 * whose entire purpose is idempotent retries was issuing responses that could
 * never be finalized.
 *
 * An extension is not a new lease. Same path, same version, same object
 * identity — so it keeps the generation it adopted, and both retries hand back
 * the SAME `uploadLease`. Both are finalizable, which is the property that was
 * missing. A genuinely new lease (the create, the resume repath, the re-arm
 * repath) still mints one, because those DO change the path or the version.
 *
 * The full `leaseFence` is now the CAS, nonce and expiry included, so exactly
 * one adopter writes per observed generation. The loser is not a conflict: it
 * re-reads and tries again against what it now sees, which is how two honest
 * retries both end up holding the winner's lease rather than one of them being
 * told 409. A lost CAS is only reported as `conflict` when the row has moved
 * somewhere this rule cannot follow (repathed, published, parked) or the
 * attempts run out.
 *
 * AND THE RESULT IS REVALIDATED AFTER SIGNING. The CAS proves the lease was
 * ours when we wrote it; signing is a network round trip, and a concurrent
 * resume can bump the version and repath the row while it is in flight. A
 * nonce returned without that second look is one the row may already have
 * moved past — the same un-finalizable 200, arrived at from the other side.
 */
export async function reuseLiveLease(
    row: LeaseRow,
    ext: string,
    deps: LeaseDeps,
    rearm: Record<string, unknown> = {},
    /**
     * The hash THIS request announced. A live lease's is immutable, so a
     * disagreement is a refusal rather than an overwrite -- see LeaseReuse.
     */
    expectedSha256 = "",
): Promise<LeaseReuse | null> {
    const now = () => (deps.now ? deps.now() : Date.now());
    let observed: LeaseRow = row;

    for (let attempt = 0; attempt < MAX_LEASE_ADOPTION_ATTEMPTS; attempt++) {
        const at = now();
        const path = liveLeasePath(observed, ext, at);
        if (!path) {
            // A LIVE LEASE THIS REQUEST DISAGREES WITH IS A REFUSAL, never a
            // fall-through: the destructive branch would repath and rotate a
            // lease whose signed URL is still in somebody's hands.
            if (hasLiveLease(observed, at)) {
                return {
                    kind: "identity-conflict",
                    field: "mime",
                    expiresAt: observed.uploadUrlExpiresAt as Date,
                };
            }
            // Nothing live relies on this row any more, so the caller's
            // destructive branch is safe. On a re-read this can also mean the
            // winner took a NEW lease at a new path, which is equally a
            // "not my business" answer.
            return null;
        }
        if (!sha256Agrees(observed, expectedSha256)) {
            return {
                kind: "identity-conflict",
                field: "sha256",
                expiresAt: observed.uploadUrlExpiresAt as Date,
            };
        }

        // The generation this adoption will hand back. A row that already has
        // one keeps it; a legacy row that never had one (null) gets a fresh
        // value, and the CAS below pins the null so only one writer mints it.
        const uploadLease = observed.uploadLeaseNonce ?? (deps.nonce ?? newLeaseNonce)();

        const { count } = await deps.db.updateMany({
            where: { id: observed.id, storagePath: observed.storagePath, ...leaseFence(observed) },
            data: {
                // `rearm` carries a recovery's own state writes (clearing the
                // verified hash, cancelling a retry). It must NOT carry the
                // lease's identity -- see the guards above: a live lease's
                // expectedSha256 and mime are fixed, and writing them here is
                // exactly how two callers came to share one generation for two
                // different documents.
                ...rearm,
                // ADOPTED, not overwritten: a legacy lease that announced no
                // hash takes this request's, which sha256Agrees just allowed.
                expectedSha256: observed.expectedSha256 || expectedSha256 || null,
                uploadUrlExpiresAt: extendedExpiry(observed.uploadUrlExpiresAt, deps.expiresAt()),
                uploadLeaseNonce: uploadLease,
            },
        });

        if (count === 0) {
            // Somebody else wrote the row. Re-read — but only retry if what is
            // there now is still the lease this caller decided about. Anything
            // else is a conflict, and NEVER a fall-through to the destructive
            // branch on the strength of a row that has demonstrably changed.
            const fresh = await deps.reload(observed.id);
            if (!fresh || !sameLease(row, fresh)) return { kind: "conflict" };
            observed = fresh;
            continue;
        }

        // THE ONE PLACE AN UPSERT-CAPABLE TOKEN IS ISSUED.
        //
        // This is the reuse path: the path already exists as far as the client
        // is concerned, and the whole point is to let it replace a partial or
        // superseded upload of its own. Every other issuer signs a path a
        // version bump has just made new, so a create-only token is enough
        // there and the weaker capability is what they get (see
        // createReceiptUploadUrl).
        const signed = await deps.sign(path, { upsert: true });
        if (!signed) return { kind: "storage-unavailable" };

        // POST-SIGN REVALIDATION. See the header: the sign is a round trip, and
        // a lease returned without re-reading may already be superseded.
        const confirmed = await deps.reload(observed.id);
        if (!confirmed || !sameLease(row, confirmed)) return { kind: "conflict" };
        if (confirmed.uploadLeaseNonce !== uploadLease) {
            // Another adopter re-stamped the generation between our write and
            // our signing. Converge on theirs rather than returning a nonce
            // /finalize would refuse.
            observed = confirmed;
            continue;
        }

        return { kind: "signed", signed: { ...signed, uploadLease } };
    }

    // Every attempt lost. The client retries the whole call and reads whatever
    // the winner left, which is the same answer a lost CAS has always given.
    return { kind: "conflict" };
}

/**
 * IS THE LEASE THIS RESPONSE IS ABOUT TO RETURN STILL THE PERSISTED ONE?
 *
 * The three branches that mint a genuinely new lease — the create, the resume
 * repath and the re-arm repath — all write the row, then sign, then answer. The
 * sign is a network round trip, and a concurrent /start can adopt or repath the
 * row while it is in flight; the nonce those branches were returning was simply
 * the one they had generated, never re-checked. A client that acted on it got
 * `409 lease-stale` from /finalize for a URL it had just been given.
 *
 * `reuseLiveLease` handles its own supersession by looping, because it can:
 * adopting an existing lease again is idempotent. These branches cannot — their
 * write was destructive and re-running it would repath the row a second time —
 * so a superseded lease is answered as the retryable publish-conflict the
 * caller already has, and the client re-runs /start.
 */
export async function issuedLeaseIsCurrent(
    id: string,
    expect: { storagePath: string; uploadLease: string },
    reload: (id: string) => Promise<LeaseRow | null>,
): Promise<boolean> {
    const fresh = await reload(id);
    return !!fresh
        && fresh.storagePath === expect.storagePath
        && fresh.uploadLeaseNonce === expect.uploadLease;
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
        // THE SHARED BUILDER, like every other lease-bearing write. The row was
        // INSERTed by this request moments ago, so its state is "STAGING" and
        // its reason and claim are null by construction — stating them through
        // leaseFence costs nothing and keeps this delete inside the one rule
        // rather than beside it. `storagePath` rides along for the same reason
        // the reject's does: a delete must be sure which object it accounts for.
        where: {
            id: created.id,
            storagePath: created.storagePath,
            ...leaseFence({
                state: "STAGING",
                stateReason: null,
                uploadLeaseVersion: created.uploadLeaseVersion,
                uploadLeaseNonce: created.uploadLeaseNonce,
                uploadUrlExpiresAt: created.uploadUrlExpiresAt,
            }),
        },
    });
    return count > 0 ? "discarded" : "resumed";
}
