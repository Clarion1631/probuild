// Adds REVERSED to the ReceiptIntake.state CHECK constraint, for the admin-only
// "Reverse booking" action (src/lib/receipt-intake/reverse-booking.ts).
//
// Additive and idempotent: reads the current constraint definition and replaces
// it only when it differs from the wanted one, so a rerun is a no-op. Every
// existing state stays in the set, so the ADD's validation of existing rows
// cannot fail on live data. Safe to run against prod while the old build is
// live (the old build never writes REVERSED). Run it BEFORE deploying the build
// that writes it: until then a reversal would be rejected by the old CHECK.
//
// The same SQL ships as prisma/migrations/20261028000000_receipt_intake_reversed_state;
// tests/apply-receipt-reversed-state.test.ts keeps the two in step. Both
// scripts/apply-receipt-intake.mjs and this one now allow the same 14 states, so
// running either (in any order, any number of times) leaves the same CHECK.
//
// Same gate as scripts/apply-receipt-memo-content.mjs (the shared target guard):
//   node scripts/apply-receipt-reversed-state.mjs --target prod|ci --yes \
//        --expect-db <name> --expect-host <host>
// Nothing runs on import; everything sits inside main() behind the entrypoint guard.
import { resolveTargetOrRefuse, verifyTargetIdentity } from "./lib/apply-target.mjs";
import { pathToFileURL } from "node:url";

// The wanted state set, as literals on purpose: module scope may not call anything
// (tests/apply-scripts-inert-on-import.test.ts).
export const WANTED_STATES = [
    "STAGING", "RECEIVED", "READ", "NEEDS_JOB", "NEEDS_REVIEW", "BOOKING",
    "BOOKED", "ARCHIVED", "DUPLICATE", "VOID", "NON_RECEIPT", "REVERSED",
    "SHADOW_DONE", "SHADOW_QUARANTINE",
];

// What pg_get_constraintdef prints for the CHECK below, so a rerun compares equal.
export const WANTED_DEF = "CHECK ((state = ANY (ARRAY['STAGING'::text, 'RECEIVED'::text, 'READ'::text, 'NEEDS_JOB'::text, 'NEEDS_REVIEW'::text, 'BOOKING'::text, 'BOOKED'::text, 'ARCHIVED'::text, 'DUPLICATE'::text, 'VOID'::text, 'NON_RECEIPT'::text, 'REVERSED'::text, 'SHADOW_DONE'::text, 'SHADOW_QUARANTINE'::text])))";

const READ_DEF = `SELECT pg_get_constraintdef(oid) AS def
                    FROM pg_constraint
                   WHERE conname = 'ReceiptIntake_state_check'
                     AND conrelid = '"ReceiptIntake"'::regclass`;

const LOCK_TIMEOUT_MS = 5000;
// Longer than lock_timeout on purpose: the transaction must be allowed to wait
// out the lock and then do the work, and Prisma's default (5s) would abort it
// right as the lock is granted.
const TRANSACTION_TIMEOUT_MS = 30000;

async function currentDef(client) {
    const rows = await client.$queryRawUnsafe(READ_DEF);
    return rows.length ? rows[0].def : null;
}

async function main() {
    const targeted = resolveTargetOrRefuse(process.argv);
    if (targeted.error) throw new Error("migration target refused");
    const argv = process.argv.slice(2);
    const valueOf = flag => argv[argv.indexOf(flag) + 1];
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({ datasources: { db: { url: targeted.url } } });
    try {
        await prisma.$connect();
        const identity = await verifyTargetIdentity(prisma, {
            ...targeted,
            expectDb: valueOf("--expect-db"),
            expectHost: valueOf("--expect-host"),
        });
        if (!identity.ok) throw new Error("migration target identity refused");

        const exists = await prisma.$queryRawUnsafe(`SELECT to_regclass('"ReceiptIntake"') IS NOT NULL AS present`);
        if (!exists[0]?.present) throw new Error("ReceiptIntake does not exist; run apply-receipt-intake.mjs first");
        if ((await currentDef(prisma)) === WANTED_DEF) {
            console.log("ReceiptIntake_state_check already allows REVERSED - nothing to do.");
            return;
        }
        await prisma.$transaction(
            async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
                await tx.$executeRawUnsafe(`LOCK TABLE "ReceiptIntake" IN ACCESS EXCLUSIVE MODE`);
                // Re-check under the lock so two concurrent runs cannot both rebuild it.
                if ((await currentDef(tx)) === WANTED_DEF) {
                    console.log("  another run got there first - nothing to do.");
                    return;
                }
                await tx.$executeRawUnsafe(`ALTER TABLE "ReceiptIntake" DROP CONSTRAINT IF EXISTS "ReceiptIntake_state_check"`);
                await tx.$executeRawUnsafe(
                    `ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_state_check"
                       CHECK ("state" IN (${WANTED_STATES.map(s => `'${s}'`).join(", ")}))`,
                );
            },
            { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_TIMEOUT_MS },
        );
        const final = await currentDef(prisma);
        if (final !== WANTED_DEF) throw new Error(`Verification failed: constraint is now ${final}`);
        console.log("applied: ReceiptIntake_state_check now allows REVERSED.");
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    main().catch(error => {
        console.error("migration failed:", error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
