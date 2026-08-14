import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizePayee, assignLineHashes, type BankLineIdentity } from "@/lib/bank-ledger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Bank ledger ingest (Receipt Automation Phase 1,
 * docs/RECEIPT-AUTOMATION-PHASES.md "Persistence decision"). Local parsers
 * (scripts/parse-wtb-statement.mjs today; a future QBO-register puller) POST
 * raw statement lines here; this endpoint is the single writer that assigns
 * durable identity — normalizedPayee + lineHash — and upserts append-only,
 * never duplicating a line that was already ingested.
 *
 * Auth: x-ingest-key header must equal BANK_LEDGER_INGEST_SECRET, the same
 * shared-secret contract as receipt-ingest and qbo-receipts/create.
 */

const MAX_LINES_PER_REQUEST = 5000;
const VALID_SOURCES = new Set(["STATEMENT", "QBO_REGISTER"]);

interface IngestLineInput {
    postedDate?: unknown; // YYYY-MM-DD
    amountCents?: unknown;
    rawDescriptor?: unknown;
    checkNumber?: unknown;
}

interface IngestBody {
    source?: unknown;
    account?: unknown;
    lines?: unknown;
}

interface ValidatedLine extends BankLineIdentity {
    checkNumber: string | null;
}

function validateLine(raw: IngestLineInput): ValidatedLine | null {
    const { postedDate, amountCents, rawDescriptor, checkNumber } = raw;
    if (typeof postedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(postedDate)) return null;
    if (typeof amountCents !== "number" || !Number.isFinite(amountCents) || !Number.isInteger(amountCents)) return null;
    if (typeof rawDescriptor !== "string" || !rawDescriptor.trim()) return null;
    if (checkNumber !== undefined && checkNumber !== null && typeof checkNumber !== "string") return null;
    return {
        postedDate,
        amountCents,
        rawDescriptor,
        checkNumber: typeof checkNumber === "string" ? checkNumber : null,
    };
}

export interface BankLedgerIngestHandlerDependencies {
    getIngestSecret(): string | undefined;
    findExistingHashes(hashes: string[]): Promise<Set<string>>;
    createLines(rows: Array<{
        account: string;
        postedDate: string;
        amountCents: number;
        rawDescriptor: string;
        normalizedPayee: string;
        checkNumber: string | null;
        source: string;
        lineHash: string;
    }>): Promise<number>;
}

export function createBankLedgerIngestHandlers(dependencies: BankLedgerIngestHandlerDependencies) {
    return {
        async POST(request: Request) {
            const secret = dependencies.getIngestSecret();
            if (!secret || request.headers.get("x-ingest-key") !== secret) {
                return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
            }

            let body: IngestBody;
            try {
                body = await request.json();
            } catch {
                return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
            }

            if (typeof body.source !== "string" || !VALID_SOURCES.has(body.source)) {
                return NextResponse.json({ ok: false, reason: "invalid-source" }, { status: 400 });
            }
            if (typeof body.account !== "string" || !body.account.trim()) {
                return NextResponse.json({ ok: false, reason: "missing-account" }, { status: 400 });
            }
            if (!Array.isArray(body.lines) || body.lines.length === 0) {
                return NextResponse.json({ ok: false, reason: "missing-lines" }, { status: 400 });
            }
            if (body.lines.length > MAX_LINES_PER_REQUEST) {
                return NextResponse.json({ ok: false, reason: "too-many-lines", max: MAX_LINES_PER_REQUEST }, { status: 400 });
            }

            const account = body.account;
            const source = body.source;

            const validated: ValidatedLine[] = [];
            for (const raw of body.lines as IngestLineInput[]) {
                const line = validateLine(raw ?? {});
                if (!line) {
                    return NextResponse.json({ ok: false, reason: "invalid-line", line: raw }, { status: 400 });
                }
                validated.push(line);
            }

            const hashed = assignLineHashes(account, validated);
            const hashes = hashed.map(l => l.lineHash);

            const existingHashes = await dependencies.findExistingHashes(hashes);
            const toInsert = hashed.filter(l => !existingHashes.has(l.lineHash));

            const rows = toInsert.map(line => ({
                account,
                postedDate: line.postedDate,
                amountCents: line.amountCents,
                rawDescriptor: line.rawDescriptor,
                normalizedPayee: normalizePayee(line.rawDescriptor),
                checkNumber: line.checkNumber,
                source,
                lineHash: line.lineHash,
            }));

            const inserted = rows.length > 0 ? await dependencies.createLines(rows) : 0;
            const existing = hashed.length - inserted;

            return NextResponse.json({ ok: true, inserted, existing });
        },
    };
}

const handlers = createBankLedgerIngestHandlers({
    getIngestSecret: () => process.env.BANK_LEDGER_INGEST_SECRET,
    findExistingHashes: async hashes => {
        const rows = await prisma.bankLine.findMany({
            where: { lineHash: { in: hashes } },
            select: { lineHash: true },
        });
        return new Set(rows.map(r => r.lineHash));
    },
    createLines: async rows => {
        const result = await prisma.bankLine.createMany({
            data: rows.map(row => ({ ...row, postedDate: new Date(`${row.postedDate}T12:00:00Z`) })),
            skipDuplicates: true,
        });
        return result.count;
    },
});

export async function POST(request: Request) {
    return handlers.POST(request);
}
