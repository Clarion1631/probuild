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
// tests/apply-receipt-reversed-state.test.ts keeps the two in step.
//
// Usage: node scripts/apply-receipt-reversed-state.mjs
import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

// DATABASE_URL (the pooler) on purpose, matching every sibling apply-*.mjs.
function resolveDatabaseUrl() {
    const fromEnv = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
    if (fromEnv) return fromEnv;
    for (const file of [".env", ".env.local"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return match[1];
    }
    throw new Error("DATABASE_URL not found in env or .env files");
}

export const WANTED_STATES = [
    "STAGING", "RECEIVED", "READ", "NEEDS_JOB", "NEEDS_REVIEW", "BOOKING",
    "BOOKED", "ARCHIVED", "DUPLICATE", "VOID", "NON_RECEIPT", "REVERSED",
    "SHADOW_DONE", "SHADOW_QUARANTINE",
];

// What pg_get_constraintdef prints for the CHECK below, so a rerun compares equal.
// A literal on purpose: module scope may not call anything (inert-on-import).
export const WANTED_DEF = "CHECK ((state = ANY (ARRAY['STAGING'::text, 'RECEIVED'::text, 'READ'::text, 'NEEDS_JOB'::text, 'NEEDS_REVIEW'::text, 'BOOKING'::text, 'BOOKED'::text, 'ARCHIVED'::text, 'DUPLICATE'::text, 'VOID'::text, 'NON_RECEIPT'::text, 'REVERSED'::text, 'SHADOW_DONE'::text, 'SHADOW_QUARANTINE'::text])))";

const READ_DEF = `SELECT pg_get_constraintdef(oid) AS def
                    FROM pg_constraint
                   WHERE conname = 'ReceiptIntake_state_check'
                     AND conrelid = '"ReceiptIntake"'::regclass`;

let url;
let prisma;

async function currentDef(client) {
    const rows = await client.$queryRawUnsafe(READ_DEF);
    return rows.length ? rows[0].def : null;
}

async function main() {
    console.log(`Applying to ${url.replace(/:[^:@]*@/, ":****@")}`);
    if ((await currentDef(prisma)) === WANTED_DEF) {
        console.log("ReceiptIntake_state_check already allows REVERSED - nothing to do.");
        return;
    }
    await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s';`);
        await tx.$executeRawUnsafe(`LOCK TABLE "public"."ReceiptIntake" IN ACCESS EXCLUSIVE MODE;`);
        // Re-check under the lock so two concurrent runs cannot both rebuild it.
        if ((await currentDef(tx)) === WANTED_DEF) {
            console.log("  another run got there first - nothing to do.");
            return;
        }
        await tx.$executeRawUnsafe(`ALTER TABLE "ReceiptIntake" DROP CONSTRAINT IF EXISTS "ReceiptIntake_state_check";`);
        await tx.$executeRawUnsafe(
            `ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_state_check"
               CHECK ("state" IN (${WANTED_STATES.map(s => `'${s}'`).join(", ")}));`,
        );
    });
    const final = await currentDef(prisma);
    if (final !== WANTED_DEF) {
        throw new Error(`Verification failed: constraint is now ${final}`);
    }
    console.log("applied: ReceiptIntake_state_check now allows REVERSED.");
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    url = resolveDatabaseUrl();
    prisma = new PrismaClient({ datasources: { db: { url } } });
    main()
        .catch(error => {
            console.error(error);
            process.exitCode = 1;
        })
        .finally(() => prisma.$disconnect());
}
