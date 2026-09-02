// Aligns the mirrored milestone timestamp columns across the two sides of the money path.
//
// EstimatePaymentSchedule.paymentDate/.paidAt are timestamptz(6), while their mirrored twins
// PaymentSchedule.paymentDate/.paidAt were zone-LESS timestamp(3). Settle/unsettle paths copy
// values between the pairs, so every copy crossed timestamp semantics. Nothing has drifted yet
// only because the Postgres session TimeZone is UTC, which makes the implicit conversion a
// no-op — a latent dependency on a session setting, not a property of the schema.
//
// This converts the invoice side UP to timestamptz(6) so both sides match.
//
// SAFETY
//  - Value-preserving: the USING clause pins the interpretation to UTC explicitly rather than
//    inheriting the session TimeZone, so each stored wall clock is reinterpreted as the UTC
//    instant it already effectively was. Every existing value round-trips to the identical
//    rendered timestamp, and the midnight-UTC calendar-day sentinel (lib/payment-date.ts) is
//    preserved. Precision widens 3 -> 6, which cannot lose data.
//  - Idempotent: each ALTER is skipped when the column is already timestamptz.
//  - No column is dropped, renamed, or nulled.
//  - Safe to run while the OLD build is live: the old Prisma client reads and writes these
//    columns as DateTime either way, and both types round-trip identically under a UTC session.
//    PaymentSchedule is small (56 rows in prod as of 2026-08-14), so the table rewrite each
//    ALTER TYPE performs holds its ACCESS EXCLUSIVE lock only momentarily.
//
// Run BEFORE deploying the build that ships the matching schema.prisma.
// Usage: node scripts/apply-payment-timestamp-alignment.mjs
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// Same resolution the sibling apply-*.mjs scripts use: env first, then the checked-out .env
// files, since these are run by hand rather than by Next.
function resolveDatabaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    for (const file of [".env", ".env.local", ".env.production.local"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return match[1];
    }
    throw new Error("DATABASE_URL not found in env or .env files");
}

// Both columns are mirrored between the estimate and invoice sides.
const TARGETS = [
    { table: "PaymentSchedule", column: "paymentDate" },
    { table: "PaymentSchedule", column: "paidAt" },
];

async function columnType(prisma, table, column) {
    const rows = await prisma.$queryRawUnsafe(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2;`,
        table,
        column,
    );
    return rows.length ? rows[0].data_type : null;
}

async function main() {
    const url = resolveDatabaseUrl();
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
        console.log(`Applying to ${url.replace(/:[^:@]*@/, ":****@")}`);

        // Deliberately no `SET TIME ZONE`. DATABASE_URL points at the pgbouncer TRANSACTION
        // pooler, where session state does not reliably carry to the next statement — so a
        // SET here would be silent-fail fragility. It is also unnecessary: `x AT TIME ZONE
        // 'UTC'` names its zone inline and does not consult the session TimeZone. Only the
        // DISPLAY of a timestamptz depends on the session, never what gets stored.

        for (const { table, column } of TARGETS) {
            const type = await columnType(prisma, table, column);
            if (type === null) {
                console.log(`  SKIP "${table}"."${column}" — column does not exist`);
                continue;
            }
            if (type === "timestamp with time zone") {
                console.log(`  SKIP "${table}"."${column}" — already timestamptz`);
                continue;
            }
            // ALTER COLUMN TYPE takes ACCESS EXCLUSIVE and rewrites the table. Postgres
            // defaults lock_timeout to 0 (wait forever): if a long transaction is holding
            // PaymentSchedule, we would block indefinitely AND queue every application query
            // behind our pending lock request. Fail fast instead and retry in a quiet moment.
            const alterSql =
                `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE timestamptz(6) ` +
                `USING "${column}" AT TIME ZONE 'UTC'`;
            console.log(`  ${alterSql}`);
            // Two separate statements inside ONE interactive transaction, NOT a single
            // multi-statement string: Prisma sends raw SQL over the extended protocol, which
            // rejects several top-level commands in one call, so `SET ...; ALTER ...` would
            // error out before the ALTER ever ran. The transaction also pins both statements
            // to the same backend, which a bare SET could not guarantee through pgbouncer.
            // SET LOCAL (not SET) so the timeout dies with the transaction instead of leaking
            // to whoever gets this pooled connection next.
            await prisma.$transaction(
                async t => {
                    await t.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
                    await t.$executeRawUnsafe(alterSql);
                },
                { timeout: 15_000 },
            );
            console.log(`  OK   "${table}"."${column}" ${type} -> timestamptz(6)`);
        }

        // Verify BOTH mirrored sides now agree — the whole point of the change.
        const final = await prisma.$queryRawUnsafe(
            `SELECT table_name, column_name, data_type, datetime_precision
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND column_name IN ('paymentDate', 'paidAt')
            AND table_name IN ('PaymentSchedule', 'EstimatePaymentSchedule')
          ORDER BY table_name, column_name;`,
        );
        console.log("\nFinal state:");
        for (const r of final) {
            console.log(`  ${r.table_name}.${r.column_name} = ${r.data_type}(${r.datetime_precision})`);
        }
        // Assert every EXPECTED (table, column) is present AND timestamptz(6). Checking only
        // the set of data_type values would pass with a column missing entirely, or with all
        // four at the wrong precision — both of which leave the mirror misaligned.
        const EXPECTED = [
            ["EstimatePaymentSchedule", "paidAt"],
            ["EstimatePaymentSchedule", "paymentDate"],
            ["PaymentSchedule", "paidAt"],
            ["PaymentSchedule", "paymentDate"],
        ];
        for (const [table, column] of EXPECTED) {
            const row = final.find(r => r.table_name === table && r.column_name === column);
            if (!row) throw new Error(`Verification failed: "${table}"."${column}" is missing`);
            if (row.data_type !== "timestamp with time zone") {
                throw new Error(`Verification failed: "${table}"."${column}" is ${row.data_type}, expected timestamptz`);
            }
            if (Number(row.datetime_precision) !== 6) {
                throw new Error(`Verification failed: "${table}"."${column}" has precision ${row.datetime_precision}, expected 6`);
            }
        }
        if (final.length !== EXPECTED.length) {
            throw new Error(`Verification failed: expected ${EXPECTED.length} mirrored columns, found ${final.length}`);
        }
        console.log("\nAll 4 mirrored columns are timestamptz(6). Done.");
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
