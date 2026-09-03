import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertPhaseOfProjectTx } from "@/lib/phase-invariant";
import { lockEstimateAttribution } from "@/lib/expense-attribution";
import { resolveProjectPhaseCodes } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { dateOnlyInTimeZone, resolveCompanyTimeZone } from "@/lib/company-timezone";
import { matchProjectByName, matchCostCode } from "@/lib/project-match";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Namespace for the per-Drive-file ingest lock. Prefixed so it cannot collide
 * with `expenseLockKey`'s per-row keys or the QBO sync's per-Purchase ones —
 * different scopes, and two of them can be held at once.
 */
const RECEIPT_INGEST_LOCK_PREFIX = "receipt-ingest:";

/**
 * Receipt/check ingest from the "GOLDEN TOUCH — RECEIPT + CHECK AUTOMATION"
 * Google Apps Script. The script already AI-splits each document into category
 * groups (the 15 project steps) and emails the image to QuickBooks; this
 * endpoint is the ProBuild leg: one Pending expense per category group, coded
 * to the matching cost code (phase), with the Drive image linked. Vanessa
 * reviews them in /manager/receipts; they roll into /reports/profitability.
 *
 * Auth: x-ingest-key header must equal RECEIPT_INGEST_SECRET.
 * Shop/overhead docs are NOT sent here (QBO-only) — expenses require a project.
 */

interface IngestLine { sku?: string; desc?: string; price?: string | number }
interface IngestGroup { category: string; amount: number; lines?: IngestLine[] }
interface IngestPayload {
    projectName: string;
    docType?: string; // "receipt" | "check"
    vendor?: string;
    date?: string; // YYYY-MM-DD
    invoice?: string;
    checkNumber?: string;
    memo?: string;
    totalAmount?: number;
    fileId: string; // Drive file id — dedupe key, survives the archive move
    fileUrl?: string;
    fileName?: string;
    groups: IngestGroup[];
}

export async function POST(req: Request) {
    const secret = process.env.RECEIPT_INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-key") !== secret) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    let body: IngestPayload;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    if (!body.fileId || !body.projectName || !Array.isArray(body.groups) || body.groups.length === 0) {
        return NextResponse.json({ ok: false, reason: "missing-fields" }, { status: 400 });
    }

    const receiptUrl = body.fileUrl || `https://drive.google.com/file/d/${body.fileId}/view`;

    // THE DEDUPE KEY IS THE FILE ID, NOT A SUBSTRING OF A URL THE CALLER CHOSE
    // (round 34, item 1 — the failure mode this replaces).
    //
    // `receiptUrl` is `body.fileUrl` when the caller supplies one, and only
    // falls back to a url built from the id. The dedupe asked
    // `receiptUrl contains fileId`, so it was asking whether a value the
    // CALLER controls happens to embed the identity. Two ways that is wrong,
    // and neither is hypothetical — the Apps Script sends whatever Drive
    // returned for the file:
    //
    //   * a `fileUrl` that does NOT contain the id (a shortened link, a
    //     `/uc?export=...` form, a re-hosted copy) matches nothing, so every
    //     re-delivery of that document — a retry after a lost response, a
    //     re-run over the same folder — inserted the whole receipt again. The
    //     advisory lock below does not help: both deliveries agree there is no
    //     prior row, because there is no prior row the QUERY can see.
    //   * `contains` is a SUBSTRING test, so file id "abc" matches a stored
    //     url carrying "abcd". Two unrelated documents dedupe against each
    //     other and the second one is silently dropped.
    //
    // So the identity is stored in its own column, exactly as received, and
    // compared with `equals`. `receiptUrl` goes on being the human link.
    //
    // FAST PATH ONLY. This read takes no lock and is not the decision: the
    // authoritative check is the identical query repeated inside the write
    // transaction, underneath the per-file advisory lock. It stays here
    // because it also short-circuits the project match below — a re-delivery
    // of a file whose Drive folder has since been renamed used to answer
    // `alreadyIngested`, and must keep doing so rather than suddenly
    // reporting `project-not-matched`.
    const existing = await prisma.expense.findFirst({
        where: { sourceFileId: body.fileId },
        select: { id: true },
    });
    if (existing) {
        return NextResponse.json({ ok: true, alreadyIngested: true, created: 0 });
    }

    // Match the Drive folder name to a project, then its latest estimate.
    const projects = await prisma.project.findMany({
        select: {
            id: true, name: true,
            estimates: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } },
        },
    });
    const project = matchProjectByName(body.projectName, projects);
    if (!project) {
        return NextResponse.json({ ok: false, reason: "project-not-matched", projectName: body.projectName });
    }
    const estimateId = projects.find(p => p.id === project.id)?.estimates[0]?.id;
    if (!estimateId) {
        return NextResponse.json({ ok: false, reason: "project-has-no-estimate", projectId: project.id });
    }

    // The PROJECT's phases, not every active company code. Matching a Gemini
    // category string against the whole company list let a Drive import book a
    // phase that exists only on some other job — and this path writes the code
    // straight onto the expense.
    const costCodes = (await resolveProjectPhaseCodes(prismaPhaseDataSource, project.id))
        .map((phase) => ({ id: phase.id, code: phase.code, name: phase.name }));

    const isCheck = String(body.docType || "receipt").toLowerCase() === "check";
    const docRef = isCheck
        ? `Check #${body.checkNumber || "?"}${body.memo ? ` — "${body.memo}"` : ""}`
        : (body.invoice && body.invoice !== "NoInv" ? `Invoice ${body.invoice}` : "Receipt");
    // `T12:00:00` with no zone is the SERVER's noon, not the company's — on a
    // UTC host that is 05:00 Pacific, still the right day, but it is the right
    // answer by luck rather than by rule. The shared parser makes it a company
    // calendar day like every other writer.
    const companyTimeZone = await resolveCompanyTimeZone();
    const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? dateOnlyInTimeZone(body.date, companyTimeZone)
        : new Date();

    // EVERY GROUP IS VALIDATED BEFORE ANY OF THEM IS INSERTED (round 33,
    // item 2 — the failure mode this replaces).
    //
    // The loop below used to `continue` past a group whose amount was not a
    // finite number, or was zero, from INSIDE the transaction that was meant
    // to make the receipt atomic. Its valid siblings committed, the response
    // said `ok: true` with a `created` count that looked right, and the
    // file-level dedupe then matched those siblings on every retry — so the
    // malformed group could never be re-offered, and its money silently left
    // the books. "Atomic" was true of the statements and false of the
    // document.
    //
    // A document is now accepted whole or refused whole. One bad group
    // refuses all of them with a non-2xx naming the offending INDICES and
    // reasons, so the Apps Script does not archive the file, the same bytes
    // re-send, and a corrected payload ingests every group.
    //
    // There is no intake row to quarantine it on: this leg writes Expenses
    // straight from the Apps Script and owns no `ReceiptIntake` row (that is
    // the v2 pipeline's table, reached through a different route). The failure
    // is surfaced the two ways this route has: a structured server-log line,
    // and a response the caller cannot mistake for success.
    const invalidGroups = body.groups.flatMap((group, index) => {
        const category = typeof group?.category === "string" ? group.category : null;
        const amount = Number(group?.amount);
        if (!Number.isFinite(amount)) {
            return [{ index, category, reason: "amount is not a finite number" }];
        }
        if (Math.round(amount * 100) / 100 === 0) {
            return [{ index, category, reason: "amount rounds to zero" }];
        }
        return [];
    });
    if (invalidGroups.length > 0) {
        console.error(
            "[receipt-ingest] invalid-group: refusing the whole document",
            JSON.stringify({ fileId: body.fileId, projectId: project.id, invalidGroups }),
        );
        return NextResponse.json(
            {
                ok: false,
                reason: "invalid-group",
                retryable: true,
                fileId: body.fileId,
                invalidGroups,
            },
            { status: 422 },
        );
    }

    // ONE TRANSACTION FOR THE WHOLE RECEIPT (round 31, item 1 — the failure
    // mode this replaces).
    //
    // Each group used to commit through its own `prisma.$transaction`, so an
    // attribution race on group 2 left group 1 already written: a receipt
    // that arrived as one document ended up split, with `created > 0` telling
    // the caller it succeeded and a retry then reporting `alreadyIngested`
    // (the dedupe at the top keys on the whole file, not on which groups
    // actually landed) — a permanently lost group with no path back.
    //
    // Every group's insert now runs inside ONE transaction: either the whole
    // receipt lands or none of it does. A group that cannot be attributed
    // ABORTS the transaction — it does not skip past its own group and leave
    // the rest committed — and the caller gets a retryable failure, never a
    // partial success.
    class AttributionRaceError extends Error {}

    type GroupResult = {
        category: string;
        phaseId: string | null;
        costCode: { id: string; code: string; name: string } | null;
    };

    let created = 0;
    const warnings: string[] = [];

    try {
        const outcome = await prisma.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };

            // ONE DELIVERY AT A TIME, PER DRIVE FILE (round 33, item 1 — the
            // failure mode this replaces).
            //
            // The dedupe above ran BEFORE the transaction. Two concurrent
            // deliveries of the same file — the Apps Script retrying a request
            // whose response was lost, or two runs overlapping — both read
            // "no expense carries this file id", and both then inserted every
            // group. The receipt was booked twice, on the same job, with
            // nothing in the data to tell the copies apart.
            //
            // `pg_advisory_xact_lock` serialises them on the file's identity
            // for the rest of the transaction (it releases at COMMIT or
            // ROLLBACK, so there is no unlock to forget), and the dedupe is
            // re-asked underneath it. The loser now reads the winner's
            // committed rows and returns the idempotent answer instead of a
            // second copy.
            //
            // `hashtextextended` for the same reason `lockExpense` uses it: it
            // returns the bigint the lock function wants, and collides far
            // less often than the 32-bit `hashtext`. A collision only makes
            // two unrelated files serialise, which costs nothing here.
            //
            // AND A UNIQUE INDEX NOW BACKS IT UP. The previous round said
            // plainly that nothing did, because every group of one receipt
            // shared the same `receiptUrl` and there was no per-group
            // ordinal to key on. Both of those columns exist now
            // (`sourceFileId`, `sourceGroupIndex`), so the partial unique
            // index `Expense_sourceFileId_sourceGroupIndex_key` refuses a
            // second copy of a group even from a writer that never takes this
            // lock. A violation aborts the whole transaction — the document is
            // written whole or not at all — and the retry then reads the
            // winner's committed rows and answers `alreadyIngested`.
            await raw.$queryRawUnsafe(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS lock_result",
                `${RECEIPT_INGEST_LOCK_PREFIX}${body.fileId}`,
            );
            const alreadyIngested = await tx.expense.findFirst({
                where: { sourceFileId: body.fileId },
                select: { id: true },
            });
            if (alreadyIngested) return null;

            const outcomes: GroupResult[] = [];
            for (const [groupIndex, group] of body.groups.entries()) {
                // Finite and non-zero by the validation above, which refuses
                // the whole document rather than letting this loop skip a
                // group out of a transaction that then reports success.
                const amount = Math.round(Number(group.amount) * 100) / 100;

                const costCode = matchCostCode(group.category || "", costCodes);
                const lineSummary = (group.lines || [])
                    .slice(0, 6)
                    .map(l => l.desc)
                    .filter(Boolean)
                    .join("; ");

                // THE PAIR, RE-READ UNDER LOCK (round 21, item 1). `estimateId`
                // was the project's latest estimate as of a query taken before
                // the phase lookup, the date resolution and every earlier
                // group in this loop. An estimate moved to another job in that
                // window would be written next to the OLD project — one
                // expense on two jobs, which no report can be right about. A
                // mismatch aborts the WHOLE transaction (round 31) rather than
                // skipping just this group, since the groups sharing this
                // window's outcome share the same receipt.
                const pair = await lockEstimateAttribution(raw, estimateId);
                if (!pair || pair.projectId !== project.id) {
                    throw new AttributionRaceError(
                        "This job's estimate moved to another job while the receipt was being imported",
                    );
                }

                // A MATCHED PHASE IS STILL A CLAIM ABOUT THIS JOB (round 18,
                // item 4). `matchCostCode` is a string match over the
                // company's codes; it knows nothing about which phases this
                // job carries. The invariant locks the four tables it rests on
                // and answers on this same transaction; a code that is not (or
                // no longer) a phase of this job is dropped rather than
                // posted, with the same warning an unmatched category already
                // produces.
                let phaseId = costCode?.id ?? null;
                if (phaseId) {
                    // Asked about the LOCKED job, like everything else past
                    // this point. It equals `project.id` by the check above;
                    // naming the locked value keeps that true if the check
                    // ever moves.
                    const verdict = await assertPhaseOfProjectTx(raw, pair.projectId, phaseId);
                    if (!verdict.ok) phaseId = null;
                }
                await tx.expense.create({
                    data: {
                        // ONE PAIR, from one locked read.
                        estimateId: pair.estimateId,
                        projectId: pair.projectId,
                        costCodeId: phaseId,
                        // THE SOURCE DOCUMENT'S IDENTITY, ON EVERY GROUP. The
                        // id exactly as the caller sent it — the dedupe above
                        // compares it with `equals`, so anything derived from
                        // it (a url, a normalised form) would reintroduce the
                        // mismatch this replaces. The ordinal is what makes
                        // the pair unique per row: the file id alone repeats
                        // across every group of one receipt.
                        sourceFileId: body.fileId,
                        sourceGroupIndex: groupIndex,
                        // The category came from the Apps Script's Gemini
                        // read, not from a person — "ai", never "capture", so
                        // nothing downstream treats it as a human's answer.
                        // No confidence: matchCostCode is a string match and
                        // has no score to report, and inventing one would be
                        // a guess presented as a measurement.
                        costCodeSource: phaseId ? "ai" : null,
                        costCodeConfidence: null,
                        amount,
                        vendor: body.vendor || "Unknown",
                        date,
                        status: "Pending",
                        receiptUrl,
                        description:
                            `[Drive import] ${docRef} · ${group.category}` +
                            (lineSummary ? ` · ${lineSummary}` : "") +
                            ` · pending bookkeeper review`,
                    },
                });
                outcomes.push({ category: group.category, phaseId, costCode });
            }
            return outcomes;
        });

        // The lock's loser: the winner's rows are committed and visible, so
        // this delivery has nothing to add. Byte-identical to the fast path's
        // answer above, because it is the same fact.
        if (outcome === null) {
            return NextResponse.json({ ok: true, alreadyIngested: true, created: 0 });
        }

        for (const result of outcome) {
            if (!result.costCode) {
                warnings.push(`No cost code matched "${result.category}" — expense created without a phase`);
            } else if (result.phaseId === null) {
                warnings.push(
                    `"${result.category}" matched ${result.costCode.code}, which is not a phase of this job — expense created without one`,
                );
            }
            created++;
        }
    } catch (error) {
        if (error instanceof AttributionRaceError) {
            // Retryable, not a normal failure shape: the Apps Script's
            // archive move must NOT happen on this response, so the same
            // Drive file re-sends and re-attempts against the estimate's
            // current project.
            return NextResponse.json(
                { ok: false, reason: "attribution-race", retryable: true },
                { status: 409 },
            );
        }
        throw error;
    }

    // No `no-valid-groups` answer any more: an empty `groups` array is already
    // a 400 at the top, and a group that would have produced it is now the 422
    // above — which, unlike the old 200-with-`ok: false`, cannot be read as
    // "handled, archive the file".
    return NextResponse.json({ ok: true, created, projectId: project.id, projectName: project.name, warnings });
}
