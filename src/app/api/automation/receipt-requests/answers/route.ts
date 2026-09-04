import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authenticateBridge } from "@/lib/receipt-intake/intake-auth";
import { evaluateReviewIssue } from "@/lib/review-alert-lifecycle";
import {
    RECEIPT_REQUEST_TARGET_TYPE,
    bankLineIdFromFingerprint,
    driveFileIdFromUrl,
    hasResolution,
    isDurableArtifactUrl,
} from "@/lib/receipt-requests";
import {
    REQUIRED_ASSOCIATION_FIELDS,
    matchCardAssociation,
    missingAssociationFields,
} from "@/lib/receipt-card-history";
import { isDriveFileId, probeDriveFile } from "@/lib/google-drive";
import { parseMissingReceiptDetails } from "@/app/automation/receipts-data";
import { affidavitNameVerdict } from "@/lib/receipt-affidavit-name";

export const dynamic = "force-dynamic";

/**
 * The `chat-job-answers.json` bridge, other direction (Phase 2 §4 "close the
 * loop"). A qbo-clasp forwarder posts each NEW record from that file here.
 *
 * We handle exactly one kind: a SIGNED memo against one of our own
 * fingerprints (`pb-<bankLineId>`). That closes the chase, because a signed
 * affidavit IS the evidence when no merchant receipt exists.
 *
 * Photo and job-name answers deliberately need nothing here: the resulting
 * Expense or ReceiptIntake closes the issue through the nightly matcher, which
 * is the one place that decides whether evidence exists. A second closing path
 * would be a second truth.
 *
 * Beverly mints her own fingerprints for her own asks. Those are answered with
 * `{ok:true, ignored:true}` — not an error. The forwarder ships one file for
 * both systems and must not retry forever on rows that were never ours.
 *
 * NEVER emails anything, and never downloads the PDF: it reads the file's
 * METADATA to prove it exists, then records the id and a link. A `signed:true`
 * with no `pdf_id`, or one naming a file Drive says is not there, writes
 * nothing (422); a Drive we cannot reach is a 503 with `retry`, never a
 * recorded resolution.
 *
 * AUTH: the Phase 1 machine secret, fail-closed. Exact-match proxy bypass, so
 * the caller gets a clean 401 rather than a redirect. No session branch exists.
 */

interface AnswerBody {
    fingerprint?: unknown;
    signed?: unknown;
    /** The affidavit app's Drive file id. REQUIRED for a signature. */
    pdf_id?: unknown;
    /** Optional convenience link. Never the proof — see the artifact block. */
    pdf_url?: unknown;
    job?: unknown;
    at?: unknown;
    message?: unknown;
    /**
     * The Chat thread the answer was signed in. NOT decoration: this is the
     * only field that ties a memo to the card that asked for it, and it is
     * compared against this issue's own card history (see the association
     * block in POST).
     */
    thread?: unknown;
    /** The "sign N" number on the card, when the bridge carries it. */
    n?: unknown;
    /** The card's request id. Snake_case is the bridge file's convention; both are accepted. */
    request_id?: unknown;
    requestId?: unknown;
}

/** The card fields an answer may carry, normalized. Anything malformed reads as absent, never as a match. */
function associationFromBody(body: AnswerBody): { thread: string | null; n: number | null; requestId: string | null } {
    const requestId = typeof body.request_id === "string" && body.request_id.trim()
        ? body.request_id.trim()
        : typeof body.requestId === "string" && body.requestId.trim()
            ? body.requestId.trim()
            : null;
    return {
        thread: typeof body.thread === "string" && body.thread.trim() ? body.thread.trim() : null,
        n: typeof body.n === "number" && Number.isInteger(body.n) ? body.n : null,
        requestId,
    };
}

/**
 * Record a refused memo answer where the morning digest will see it.
 *
 * `pipeline-health`'s 24h error count reads AutomationEvent for ANY kind, so an
 * "error" row here surfaces the same day rather than leaving a chase that
 * quietly never resolves and a bridge nobody knows is misconfigured. Never
 * throws: the refusal is the answer, and failing to log it must not turn a 422
 * into a 500.
 */
async function recordAnswerRejection(targetKey: string, reason: string, detail: string): Promise<void> {
    try {
        await prisma.automationEvent.create({
            data: {
                kind: "receipt-memo-answer",
                status: "error",
                reason,
                source: "bridge",
                detail: JSON.stringify({ targetKey, detail }).slice(0, 2_000),
            },
        });
    } catch (error) {
        console.error("[automation/receipt-requests/answers] rejection not recorded", error instanceof Error ? error.message : "UnknownError");
    }
}

/** A stored URL is display data; cap it so a stray blob cannot bloat the row. */
const MAX_URL_LEN = 2_000;

/**
 * True when this Drive file is already recorded as the memo-signed evidence
 * on a DIFFERENT bank-line issue. One signed affidavit answers exactly one
 * charge; accepting it a second time is how a single memo silently closes two
 * chases.
 *
 * Takes a TRANSACTION CLIENT, not the module-level `prisma` — this is now
 * always called from inside the pdfId's advisory-locked transaction (see
 * POST), so the read is against the same connection that holds the lock and
 * will perform the write. A plain `prisma.*` read here used to run OUTSIDE
 * any lock, so two concurrent signatures for the same pdfId could both read
 * "not reused yet" before either had written (Codex round-2 gate).
 */
async function pdfIdReusedElsewhere(
    tx: Prisma.TransactionClient,
    pdfId: string,
    ownTargetKey: string,
): Promise<boolean> {
    const candidates = await tx.reviewIssue.findMany({
        where: {
            targetType: RECEIPT_REQUEST_TARGET_TYPE,
            targetKey: { not: ownTargetKey },
            // Coarse pre-filter — displayDetails is TEXT, so the parsed field
            // cannot be queried directly. Verified exactly below.
            displayDetails: { contains: pdfId },
        },
        select: { displayDetails: true },
    });
    return candidates.some(row => {
        const details = parseMissingReceiptDetails(row.displayDetails);
        // hasResolution-justified: this asks "has some OTHER issue recorded this
        // pdf as its answer", which is a question about the blob, not about
        // whether that answer is well-founded. An unbacked memo elsewhere is
        // still a memo that was spent elsewhere — and it is a COARSE pre-filter:
        // the artifact table, where pdfId is UNIQUE, is what actually decides
        // reuse a few lines below (round-40 gate, finding 3).
        return hasResolution(details) && details.pdfId === pdfId;
    });
}

/**
 * The pdfId this issue is ALREADY bound to, or null.
 *
 * Only a `memo-signed` resolution binds: an issue closed by a found receipt or
 * any other resolution has no memo of its own, and a `memo-signed` row written
 * before `pdfId` was recorded (the legacy shape) has nothing to be bound to
 * either — both are free to take a first binding.
 */
function boundMemoPdfId(details: Record<string, unknown>): string | null {
    if (details.resolution !== "memo-signed") return null;
    return typeof details.pdfId === "string" && details.pdfId ? details.pdfId : null;
}

/**
 * Prisma's unique-constraint violation (P2002), duck-typed by CODE rather than
 * by `instanceof Prisma.PrismaClientKnownRequestError` — the same convention
 * review-alert-lifecycle.ts uses, so a test's fake client can throw a plain
 * `{code:"P2002"}` and a mismatched module identity cannot make the guard
 * silently fail open.
 */
function isUniqueConstraintError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/** What one locked read-check-write attempt concluded. */
type AttemptOutcome =
    | { kind: "missing" }
    | { kind: "reused" }
    | { kind: "already-bound"; detail: string }
    | { kind: "never-requested" }
    | { kind: "association-incomplete"; detail: string }
    | { kind: "wrong-thread"; detail: string }
    | { kind: "mismatch" }
    | {
        kind: "recorded";
        alreadyCleared: boolean;
        alreadyResolved: boolean;
        /**
         * The memo filename carried no amount field to cross-check (round-39
         * gate, finding 3). Reported by the caller; never a refusal, because
         * the card association is what binds this memo to this charge.
         */
        unparseableName: string | null;
    }
    | { kind: "lost-race" };

/**
 * A P2002 escaping one attempt is the DURABLE backstop firing — a concurrent
 * writer committed a `ReceiptMemoArtifact` row this attempt's insert would have
 * violated. The whole transaction rolled back, so nothing of it happened: that
 * is precisely a lost race, and the retry re-reads under a fresh lock and
 * returns the typed answer (`reused` or `already-bound`) the now-committed row
 * proves. Mapping it here rather than at the insert is deliberate — a caught
 * error inside a Postgres transaction leaves that transaction aborted, so there
 * is no continuing from it.
 */
async function withBindingBackstop(run: () => Promise<AttemptOutcome>): Promise<AttemptOutcome> {
    try {
        return await run();
    } catch (error) {
        if (isUniqueConstraintError(error)) return { kind: "lost-race" };
        throw error;
    }
}

export async function POST(request: Request) {
    // RECEIPT_BRIDGE_SECRET, not the intake key — see the threads route.
    const auth = authenticateBridge(request);
    if (!auth.ok) return auth.response;

    let bodyUnknown: unknown;
    try {
        bodyUnknown = await request.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    if (bodyUnknown === null || typeof bodyUnknown !== "object" || Array.isArray(bodyUnknown)) {
        return NextResponse.json({ ok: false, reason: "invalid-body" }, { status: 400 });
    }
    const body = bodyUnknown as AnswerBody;

    if (typeof body.fingerprint !== "string" || !body.fingerprint.trim()) {
        return NextResponse.json({ ok: false, reason: "invalid-fingerprint" }, { status: 400 });
    }
    const bankLineId = bankLineIdFromFingerprint(body.fingerprint.trim());
    if (!bankLineId) {
        return NextResponse.json({ ok: true, ignored: true });
    }

    // Only a signed memo resolves anything here. Everything else is recorded
    // by the sweep and answered by the matcher.
    if (body.signed !== true) {
        return NextResponse.json({ ok: true, ignored: true, reason: "not-a-signature" });
    }

    /**
     * AN UNKNOWN TARGET IS IGNORED BEFORE ANYTHING ELSE IS REQUIRED OF THE
     * BODY. A fingerprint shaped like ours (`pb-<bankLineId>`) but naming a
     * line whose issue was never created, or was deleted, is not an error the
     * forwarder should be told to fix by resending a "more complete" body —
     * there is nothing here to complete. Checked before `pdf_id`/Drive so a
     * malformed or partial record for a target that does not exist reads the
     * same as one that does: ignored, never retried forever.
     */
    const targetIssue = await prisma.reviewIssue.findUnique({
        where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: bankLineId } },
        select: { id: true },
    });
    if (!targetIssue) {
        return NextResponse.json({ ok: true, ignored: true, reason: "unknown-target" });
    }

    /**
     * THE ANSWER MUST NAME THE ITEM IT ANSWERS (Codex PR #443 gate round 38,
     * finding 1).
     *
     * One card lists several charges in ONE thread, and two same-amount charges
     * mint memos with interchangeable filenames — so `thread` alone identifies
     * the CARD, never the item on it. With `n` and `request_id` optional, an
     * answer that simply omitted them was matched by the thread and could close
     * either charge; the amount in the filename cannot break the tie because it
     * is the same amount.
     *
     * Refused HERE, before the Drive round trip, and refused rather than
     * guessed: a memo we cannot attribute is not evidence about any particular
     * charge. The reason names the missing fields so the operator can see it is
     * the BRIDGE that needs fixing, not the memo — and it is recorded as an
     * automation error so the digest surfaces it the same day (a rejection
     * nobody sees is a chase that quietly never resolves).
     */
    const association = associationFromBody(body);
    const missingAssociation = missingAssociationFields(association);
    if (missingAssociation.length > 0) {
        const detail = `the bridge must send ${REQUIRED_ASSOCIATION_FIELDS.join(", ")}; missing ${missingAssociation.join(", ")}`;
        await recordAnswerRejection(bankLineId, "association-incomplete", detail);
        return NextResponse.json(
            { ok: false, reason: "association-incomplete", detail, targetKey: bankLineId },
            { status: 422 },
        );
    }

    /**
     * A SIGNATURE WITHOUT A VERIFIED ARTIFACT IS NOT EVIDENCE.
     *
     * `signed:true` alone used to close the chase, so a truncated forwarder row
     * silenced a genuinely missing receipt and left nothing a human could open.
     * A URL was the next attempt and it is still not proof: a well-formed link
     * to a file that was never created, or was created and deleted, passes
     * every syntactic check there is.
     *
     * So the bridge sends the affidavit app's Drive FILE ID, and this reads its
     * metadata before recording anything. Three outcomes, three different
     * answers, and the difference is the point:
     *
     *   found       — record the resolution and clear the chase.
     *   missing     — 422. Google answered and there is no such file (or it is
     *                 in the bin). Retrying will not change that; the memo has
     *                 to be re-generated. The chase stays open.
     *   unreachable — 503. We could not ASK. Nothing is written, and the
     *                 forwarder is told to come back: "we could not check" must
     *                 never be recorded as "it checked out".
     */
    if (!isDriveFileId(body.pdf_id)) {
        return NextResponse.json(
            { ok: false, reason: "missing-artifact", detail: "a signed memo must carry its Drive pdf_id", targetKey: bankLineId },
            { status: 422 },
        );
    }
    const pdfId = (body.pdf_id as string).trim();
    const probe = await probeDriveFile(pdfId);
    if (probe.kind === "unreachable") {
        // NO CREDENTIAL is its own answer, and a different problem from a bad
        // minute at Google: it means this deployment cannot verify ANY memo
        // until somebody connects Drive, and it will not fix itself. Naming it
        // is what stops the retries reading as a transient Google outage —
        // pipeline-health reports the same condition as `drive-not-configured`.
        const unconfigured = probe.reason === "no-drive-token";
        console.error(
            unconfigured
                ? "[automation/receipt-requests/answers] Drive is NOT CONFIGURED — no memo can be verified"
                : "[automation/receipt-requests/answers] Drive unreachable",
            pdfId, probe.reason,
        );
        return NextResponse.json(
            {
                ok: false,
                reason: unconfigured ? "drive-not-configured" : "artifact-unverifiable",
                retry: true,
                detail: probe.reason,
                targetKey: bankLineId,
            },
            { status: 503 },
        );
    }
    if (probe.kind === "missing") {
        return NextResponse.json(
            { ok: false, reason: "artifact-missing", detail: probe.reason, targetKey: bankLineId },
            { status: 422 },
        );
    }
    // FOUND IS NOT ENOUGH — it only proves Drive has an object at that id, not
    // that the object is the signed memo it claims to be. Any Drive object
    // (a folder, an image, a Doc) passed `found` before this check, and this
    // route recorded `memo-signed` for it regardless. The chase stays open
    // until the bridge sends the real PDF.
    if (probe.mimeType !== "application/pdf") {
        return NextResponse.json(
            { ok: false, reason: "not-a-pdf", detail: probe.mimeType ?? "unknown", targetKey: bankLineId },
            { status: 422 },
        );
    }
    /**
     * THE LINK MUST NAME THE FILE WE JUST VERIFIED.
     *
     * `pdf_id` is proved against Drive; `pdf_url` was not proved against
     * anything. Storing the caller's link merely because it was durable-looking
     * meant the id and the URL need never describe the same object — the id
     * passes the probe, and the link a human actually clicks a year later can
     * point somewhere else entirely. So the caller's URL is accepted only when
     * the file id inside it IS `pdfId`; otherwise the probed `webViewLink`,
     * which came from the verification itself, is what gets stored.
     */
    const callerUrl = isDurableArtifactUrl(body.pdf_url) && driveFileIdFromUrl(body.pdf_url) === pdfId
        ? (body.pdf_url as string).slice(0, MAX_URL_LEN)
        : null;
    const artifactUrl = callerUrl ?? probe.webViewLink ?? null;

    // RECORD FIRST, CLEAR ONLY IF IT COMMITTED.
    //
    // This used to clear the issue even when its details CAS lost — leaving a
    // cleared issue with NO resolution, which the next nightly sweep read as
    // "still unmatched" and reopened. The memo the owner signed changed
    // nothing. So: read fresh, merge, write version-guarded, and retry ONCE
    // from another fresh read if a concurrent writer moved the row. Only a
    // committed resolution earns the clear.
    let recorded: { targetKey: string } | null = null;
    let alreadyCleared = false;
    /** The card-history race: answered already, and never carrying a record of the ask. */
    let alreadyResolved = false;
    let missing = false;
    let neverRequested = false;
    let incompleteAssociation: string | null = null;
    /**
     * A memo whose filename carried no amount to cross-check (round-39 gate,
     * finding 3). Accepted — the card association is what binds it — and
     * reported, because a generator whose escaping has drifted is something an
     * operator should fix before it can hide a genuinely wrong memo.
     */
    let unparseableName: string | null = null;
    let wrongThread: string | null = null;
    let mismatch = false;
    let reused = false;
    /** The pdfId this issue is already bound to, when a DIFFERENT one arrived. */
    let alreadyBound: string | null = null;

    for (let attempt = 0; attempt < 2 && !recorded && !alreadyCleared && !missing && !neverRequested && !incompleteAssociation && !wrongThread && !mismatch && !reused && !alreadyBound; attempt++) {
        const outcome: AttemptOutcome = await withBindingBackstop(() => prisma.$transaction(async tx => {
            /**
             * THE PDF-ID LOCK — taken BEFORE the reuse check, and held through
             * the write, on EVERY attempt (not just the first).
             *
             * The reuse check used to be a plain read outside any lock, and
             * only ran on attempt 0: two concurrent signatures naming the SAME
             * pdfId against two DIFFERENT charges could both read "not reused
             * yet" before either had written, and a lost-race retry skipped
             * the check entirely, so the SECOND attempt of a losing request
             * could still record a reuse the check exists to catch (Codex
             * round-2 gate). One transaction-scoped advisory lock per pdfId,
             * held across the read-check-write here, is what makes "not
             * reused" a fact rather than a guess: a second writer for the same
             * file blocks on this line until the first commits, and then sees
             * its resolution.
             */
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`memo-pdf:${pdfId}`}))`;

            const issue = await tx.reviewIssue.findUnique({
                where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: bankLineId } },
                select: { id: true, version: true, displayDetails: true, clearedAt: true },
            });
            if (!issue) return { kind: "missing" };

            // THE ARTIFACT MUST BE BOUND TO THIS CHARGE, not merely
            // accessible. A caller-supplied fingerprint plus any readable
            // Drive PDF used to be enough to close a chase: nothing checked
            // that this item was ever actually asked about, that the file was
            // minted FOR it, or that the SAME file was not already spent
            // answering a different one (Codex PR #443 gate, finding 3).
            if (await pdfIdReusedElsewhere(tx, pdfId, bankLineId)) return { kind: "reused" };

            /**
             * THE DURABLE BINDING, read under the same lock.
             *
             * `pdfIdReusedElsewhere` above scans `displayDetails`, which the
             * write below REWRITES in place — so a memo could be un-recorded by
             * a later one and the scan would then find nothing. These two rows
             * are the record that survives that: `pdfId` is unique, so a memo
             * that answered any charge is on file forever, and
             * (targetType, targetKey) is unique, so a charge's binding is on
             * file forever too.
             */
            const [artifactByPdf, artifactByIssue] = await Promise.all([
                tx.receiptMemoArtifact.findUnique({ where: { pdfId }, select: { targetKey: true } }),
                tx.receiptMemoArtifact.findUnique({
                    where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: bankLineId } },
                    select: { pdfId: true },
                }),
            ]);
            if (artifactByPdf && artifactByPdf.targetKey !== bankLineId) return { kind: "reused" };
            if (artifactByIssue && artifactByIssue.pdfId !== pdfId) {
                return { kind: "already-bound", detail: artifactByIssue.pdfId };
            }

            // Merged from THIS read, not from anything older: a card record or
            // a corrected amount written since must survive.
            const details = parseMissingReceiptDetails(issue.displayDetails);

            /**
             * A MEMO BINDING IS IMMUTABLE ONCE RECORDED (Codex PR #443 gate
             * round 34, finding 1).
             *
             * This used to overwrite `details.pdfId` with whatever the latest
             * answer carried, and the reuse check above deliberately EXCLUDES
             * this issue — so the sequence that mattered was: PDF-A recorded on
             * issue 1; PDF-B arrives for issue 1 and replaces it, leaving A
             * recorded nowhere; PDF-A replayed against issue 2 finds no trace of
             * itself, passes the reuse check, and closes a SECOND charge with a
             * memo that was already spent. One signed affidavit answers one
             * charge, and the identity that says so must not be mutable.
             *
             * So a second, DIFFERENT pdfId is terminal (422) — re-sending it
             * cannot make it belong here, and the issue keeps the memo it has.
             * The SAME pdfId falls through to the idempotent path below, which
             * is what lets the forwarder retry and get the same answer.
             */
            const bound = boundMemoPdfId(details);
            if (bound !== null && bound !== pdfId) return { kind: "already-bound", detail: bound };

            /**
             * THE ORIGINATING ASSOCIATION. A memo is evidence for the charge
             * whose card asked for it, and for no other.
             *
             * "Some card once listed this item" was the old test, and it is not
             * a link: it says an ask happened, not that THIS answer came from
             * it. Two charges for the same amount mint memos with
             * interchangeable filenames, so a memo signed for one charge,
             * replayed against the other's fingerprint, satisfied the amount
             * check and that ask-happened check together and closed a chase
             * nobody had answered (Codex PR #443 gate round 33, finding 3).
             * The `thread` the bridge sends was stored and never compared.
             *
             * Now the answer must name a card record ON THIS ISSUE — the thread
             * exactly, plus `n`/`requestId` when it carries them.
             *
             * A CLEARED ISSUE IS NOT EXEMPT. Round 32 let a cleared issue with
             * no card record through as the card-history race, which was a real
             * race — but it was fixed at the source (recordCardOnIssues now
             * writes on cleared issues too), and leaving the exemption here
             * meant any already-closed charge accepted a memo that had never
             * been asked for. The idempotent 200 survives only for an answer
             * whose association MATCHES.
             */
            const verdict = matchCardAssociation(details, association);
            if (verdict.kind === "never-carded") return { kind: "never-requested" };
            // Unreachable behind the guard above, and kept because the guard is
            // not what makes this safe — this is. A future caller that reaches
            // the transaction another way must hit the same wall.
            if (verdict.kind === "incomplete") return { kind: "association-incomplete", detail: verdict.detail };
            if (verdict.kind === "wrong-thread") return { kind: "wrong-thread", detail: verdict.detail };
            // Already answered BEFORE this write — the forwarder retrying, or a
            // memo landing after the matcher auto-closed the line. Either way
            // recording it again is idempotent, and nothing is closed by it.
            //
            // hasResolution-justified: a REPORTING flag on the 200 this request
            // is about to return, not a gate on anything. It answers "was there
            // already an answer here", which is true of an unbacked memo too —
            // and this route is what replaces one (round-40 gate, finding 3).
            const alreadyAnswered = hasResolution(details);
            const amountCents = typeof details.amountCents === "number" ? details.amountCents : null;
            // Checked BEFORE the already-resolved answer below, so a memo for a
            // DIFFERENT charge can never be waved through as "already resolved"
            // just because this issue happens to be closed.
            if (amountCents === null) return { kind: "mismatch" };
            const nameVerdict = affidavitNameVerdict(probe.name, amountCents);
            if (nameVerdict === "mismatch") return { kind: "mismatch" };

            details.resolution = "memo-signed";
            // The ID is the durable identity; the URL is how a human opens it.
            details.pdfId = pdfId;
            if (artifactUrl) details.pdfUrl = artifactUrl;
            if (typeof body.at === "string") details.signedAt = body.at.slice(0, 64);
            if (typeof body.thread === "string") details.signedThread = body.thread.slice(0, 200);

            // RECORDED EVEN ON A CLEARED ISSUE (Codex round-4 item 3).
            //
            // A memo signed after the nightly matcher had already auto-closed
            // the line used to be discarded — so when the matching receipt was
            // later deleted, the sweep reopened a charge somebody had
            // genuinely answered weeks earlier. A valid signature is evidence
            // whatever the issue's current state, and `resolution` is exactly
            // the field the matcher reads to suppress a reopen.
            const written = await tx.reviewIssue.updateMany({
                where: { id: issue.id, version: issue.version },
                data: { displayDetails: JSON.stringify(details), version: { increment: 1 } },
            });
            if (written.count === 1) {
                // THE BINDING, IN THE SAME TRANSACTION AS THE RESOLUTION.
                // Either both land or neither does — a resolution without its
                // artifact row is exactly the un-recorded memo this fix exists
                // to make impossible. Skipped when the row is already ours
                // (the idempotent re-submit), because the reads above proved
                // that is the only way it can exist.
                if (!artifactByPdf) {
                    await tx.receiptMemoArtifact.create({
                        data: {
                            pdfId,
                            targetType: RECEIPT_REQUEST_TARGET_TYPE,
                            targetKey: bankLineId,
                            issueId: issue.id,
                        },
                    });
                }
                return {
                    kind: "recorded",
                    alreadyCleared: issue.clearedAt !== null,
                    alreadyResolved: alreadyAnswered,
                    unparseableName: nameVerdict === "unparseable" ? probe.name ?? "" : null,
                };
            }
            return { kind: "lost-race" };
        }));

        switch (outcome.kind) {
            case "missing": missing = true; break;
            case "reused": reused = true; break;
            case "already-bound": alreadyBound = outcome.detail; break;
            case "never-requested": neverRequested = true; break;
            case "association-incomplete": incompleteAssociation = outcome.detail; break;
            case "wrong-thread": wrongThread = outcome.detail; break;
            case "mismatch": mismatch = true; break;
            case "recorded":
                recorded = { targetKey: bankLineId };
                alreadyCleared = outcome.alreadyCleared;
                alreadyResolved = outcome.alreadyResolved;
                unparseableName = outcome.unparseableName;
                break;
            case "lost-race":
                // Loop again for a fresh read — still under a fresh lock.
                break;
        }
    }

    if (missing) {
        return NextResponse.json({ ok: true, ignored: true, reason: "unknown-target" });
    }
    if (reused) {
        return NextResponse.json(
            {
                ok: false,
                reason: "artifact-reused",
                detail: "this Drive file is already recorded as memo-signed evidence on a different charge",
                targetKey: bankLineId,
            },
            { status: 409 },
        );
    }
    // THIS CHARGE ALREADY HAS A MEMO, AND IT IS NOT THIS ONE. Terminal (422),
    // like every other binding failure: re-sending cannot make a second
    // affidavit the one that answered this charge, and the recorded memo is not
    // overwritten. The detail names the memo that IS bound, so a human can open
    // it rather than guess which of the two is on file.
    if (alreadyBound) {
        return NextResponse.json(
            {
                ok: false,
                reason: "memo-already-bound",
                detail: `this charge is already answered by a different signed memo (${alreadyBound})`,
                targetKey: bankLineId,
            },
            { status: 422 },
        );
    }
    if (neverRequested) {
        return NextResponse.json(
            {
                ok: false,
                reason: "not-requested",
                detail: "no chase card has ever asked about this charge",
                targetKey: bankLineId,
            },
            { status: 422 },
        );
    }
    // A card DID ask about this charge — just not the one this answer came
    // from. Terminal, like every other binding failure: re-sending the same
    // memo from the same thread cannot make it belong to this charge. It is a
    // separate reason from `not-requested` because it means something
    // different, and the difference is what a human reading the log needs.
    if (typeof unparseableName === "string") {
        await recordAnswerRejection(
            bankLineId,
            "affidavit-name-unparseable",
            `accepted on its card association; the filename carried no amount field to cross-check: ${unparseableName.slice(0, 200)}`,
        );
    }
    if (incompleteAssociation) {
        return NextResponse.json(
            {
                ok: false,
                reason: "association-incomplete",
                detail: incompleteAssociation,
                targetKey: bankLineId,
            },
            { status: 422 },
        );
    }
    if (wrongThread) {
        return NextResponse.json(
            {
                ok: false,
                reason: "wrong-thread",
                detail: wrongThread,
                targetKey: bankLineId,
            },
            { status: 422 },
        );
    }
    if (mismatch) {
        return NextResponse.json(
            {
                ok: false,
                reason: "artifact-mismatch",
                detail: "the PDF's name does not match this charge",
                targetKey: bankLineId,
            },
            { status: 422 },
        );
    }
    if (!recorded) {
        // Two attempts both lost the race. Clearing now would silence the chase
        // with nothing on the row to say why, and the next sweep would reopen
        // it anyway. 409 so the forwarder retries — the record is idempotent.
        return NextResponse.json(
            { ok: false, reason: "resolution-not-recorded", targetKey: bankLineId },
            { status: 409 },
        );
    }

    // The issue was already closed by the matcher; the memo is now recorded on
    // it, which is the whole point — a later reopen is suppressed. Nothing to
    // clear.
    //
    // `alreadyResolved` says the row ALREADY carried a resolution before this
    // write: the forwarder retrying, or a second valid submission of the same
    // memo. A 200 with that flag, never a 422 — the forwarder must be able to
    // retry and get the same answer. It is only ever reached by an answer whose
    // originating association matched (round-33 gate, finding 3); an
    // already-closed charge with no card of its own is a 422, not a free pass.
    if (alreadyCleared) {
        return NextResponse.json({
            ok: true,
            alreadyCleared: true,
            ...(alreadyResolved ? { alreadyResolved: true } : {}),
            memoRecorded: true,
            targetKey: bankLineId,
        });
    }

    // Empty codes = lifecycle step 1 = clear, and it cancels any open episode.
    // Reached only because the resolution is durably on the row, so a sweep
    // that races this clear still sees the resolution and will not reopen.
    await evaluateReviewIssue(RECEIPT_REQUEST_TARGET_TYPE, bankLineId, [], null);

    return NextResponse.json({ ok: true, cleared: true, memoRecorded: true, targetKey: bankLineId });
}
