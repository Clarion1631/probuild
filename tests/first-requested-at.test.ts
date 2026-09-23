import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { stampFirstRequested } from "../src/lib/milestone-request-stamp";
import { statements } from "../scripts/apply-first-requested-at.mjs";

const root = path.join(__dirname, "..");

test("T1: the stamp writes ONLY firstRequestedAt, from the pre-send qbInvoiceSentAt, only while NULL, Pending only", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
        $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
            calls.push({ sql: strings.join("?"), values });
            return Promise.resolve(0);
        },
    };
    const at = new Date("2026-09-21T15:00:00.000Z");
    await stampFirstRequested(db as any, "inv-1", ["ms-1", "ms-2"], at);

    assert.equal(calls.length, 1);
    const sql = calls[0].sql.replace(/\s+/g, " ").trim();
    assert.match(sql, /UPDATE "PaymentSchedule" SET "firstRequestedAt" = COALESCE\("qbInvoiceSentAt", \?::timestamp\(3\)\) WHERE/);
    assert.match(sql, /"invoiceId" = \?/);
    assert.match(sql, /"id" = ANY\(\?::text\[\]\)/);
    assert.match(sql, /"status" = 'Pending'/);
    assert.match(sql, /"firstRequestedAt" IS NULL/);
    assert.doesNotMatch(sql, /"qbInvoiceSentAt" =/, "the last-sent column is never written here");
    assert.deepEqual(calls[0].values, [at, "inv-1", ["ms-1", "ms-2"]]);
});

test("T2: both send paths run the first-request stamp in the same transaction, before the last-sent write (source tripwire)", () => {
    const body = readFileSync(path.join(root, "src/lib/billing-core.ts"), "utf8");
    for (const marker of ["export async function sendInvoiceToClientCore", "export async function sendMilestoneInvoicesCore"]) {
        const start = body.indexOf(marker);
        assert.ok(start >= 0, `${marker} not found`);
        const next = body.indexOf("\nexport ", start + marker.length);
        const slice = next >= 0 ? body.slice(start, next) : body.slice(start);
        const i = slice.indexOf("prisma.$transaction([");
        const j = slice.indexOf("stampFirstRequested(prisma, invoiceId,");
        const k = slice.indexOf("qbInvoiceSentAt: stampedAt");
        assert.ok(i >= 0, `${marker}: prisma.$transaction([ not found`);
        assert.ok(j >= 0, `${marker}: stampFirstRequested(prisma, invoiceId, not found`);
        assert.ok(k >= 0, `${marker}: qbInvoiceSentAt: stampedAt not found`);
        assert.ok(i < j && j < k, `${marker}: expected transaction start < stamp call < last-sent write`);
    }
});

test("T3: writer manifest — exactly two qbInvoiceSentAt writers, and firstRequestedAt is written only by the stamp helper", () => {
    function walk(dir: string): string[] {
        let out: string[] = [];
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) out = out.concat(walk(full));
            else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
        }
        return out;
    }
    const srcDir = path.join(root, "src");
    const files = walk(srcDir);

    let qbInvoiceSentAtWriterCount = 0;
    const qbInvoiceSentAtWriterFiles = new Set<string>();
    const firstRequestedAtAssignmentFiles = new Set<string>();
    const firstRequestedAtInDataFiles = new Set<string>();

    for (const file of files) {
        const text = readFileSync(file, "utf8");
        const rel = path.relative(root, file).split(path.sep).join("/");

        const writerMatches = text.match(/data:\s*\{\s*qbInvoiceSentAt:/g);
        if (writerMatches) {
            qbInvoiceSentAtWriterCount += writerMatches.length;
            qbInvoiceSentAtWriterFiles.add(rel);
        }
        if (/"firstRequestedAt"\s*=/.test(text)) firstRequestedAtAssignmentFiles.add(rel);
        if (/data:\s*\{[^}]*\bfirstRequestedAt\b/.test(text)) firstRequestedAtInDataFiles.add(rel);
    }

    assert.equal(qbInvoiceSentAtWriterCount, 2, "expected exactly two qbInvoiceSentAt writers");
    assert.deepEqual([...qbInvoiceSentAtWriterFiles], ["src/lib/billing-core.ts"]);
    assert.deepEqual(
        [...firstRequestedAtAssignmentFiles],
        ["src/lib/milestone-request-stamp.ts"],
        "a new writer must go through stampFirstRequested",
    );
    assert.deepEqual(
        [...firstRequestedAtInDataFiles],
        [],
        "firstRequestedAt must never be set through a Prisma data object — a new writer must go through stampFirstRequested",
    );
});

test("T4: the apply script is the migration's twin, additive only", () => {
    const sql = readFileSync(
        path.join(root, "prisma/migrations/20260923120000_first_requested_at/migration.sql"),
        "utf8",
    );
    const migrationStatements = sql
        .split("\n")
        .filter(line => !line.trim().startsWith("--"))
        .join("\n")
        .split(";")
        .map(s => s.replace(/\s+/g, " ").trim())
        .filter(s => s.length > 0);
    const scriptStatements = statements.map((s: string) => s.replace(/\s+/g, " ").trim());

    assert.deepEqual(migrationStatements, scriptStatements);
    assert.doesNotMatch(statements.join("\n"), /DROP|DELETE|ALTER COLUMN|SET NOT NULL/i);
});
