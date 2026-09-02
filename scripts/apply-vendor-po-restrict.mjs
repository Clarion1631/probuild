// Changes PurchaseOrder.vendorId's FK from ON DELETE CASCADE to ON DELETE RESTRICT.
//
// Why: deleting a Vendor used to cascade-delete every one of its PurchaseOrders
// at the database level, which also cascaded to PurchaseOrderItem,
// PurchaseOrderFile and PurchaseOrderMessage, and severed Expense.purchaseOrderId.
// All of that bypassed deletePurchaseOrder() and its permission + scope checks.
//
// Idempotent: re-reads the current delete_rule under lock and no-ops if it is
// already RESTRICT. Safe to run against prod while the old build is live — the
// old build never intentionally relied on the cascade, and the rule only tightens.
//
// Lock behaviour: DROP + ADD CONSTRAINT takes ACCESS EXCLUSIVE on PurchaseOrder.
// Adding the FK as NOT VALID keeps that lock brief (no table scan); the separate
// VALIDATE CONSTRAINT pass then re-checks existing rows under a weaker
// SHARE UPDATE EXCLUSIVE lock that does not block reads or writes. lock_timeout
// makes the script fail fast rather than queue behind a long transaction and
// stall every query on the table behind it.
//
// Usage: node scripts/apply-vendor-po-restrict.mjs
import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

// DATABASE_URL (the pooler) on purpose, matching every sibling apply-*.mjs.
// Supabase generally recommends DIRECT_URL for migrations, but port 5432 is not
// reachable on this project's tier, so preferring it would just fail to connect.
// pgbouncer's transaction mode pins one server connection for the duration of a
// transaction, so the interactive transaction below is safe over the pooler.
// Set MIGRATION_DATABASE_URL to override (e.g. to use DIRECT_URL where it works).
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

let url;
let prisma;

// Resolve the FK from pg_catalog rather than information_schema: constraint
// names are only unique per-schema, and information_schema joins on name alone,
// so a same-named constraint in another schema can produce a bogus match. This
// pins the schema, table, referenced table and exact column list.
const FIND_FK = `
    SELECT c.conname                            AS name,
           c.confdeltype                        AS delete_type,
           c.confupdtype                        AS update_type,
           c.convalidated                       AS validated
      FROM pg_constraint c
      JOIN pg_class      t ON t.oid = c.conrelid
      JOIN pg_namespace  n ON n.oid = t.relnamespace
      JOIN pg_class      f ON f.oid = c.confrelid
      JOIN pg_namespace fn ON fn.oid = f.relnamespace
     WHERE c.contype = 'f'
       AND n.nspname = 'public' AND t.relname = 'PurchaseOrder'
       AND fn.nspname = 'public' AND f.relname = 'Vendor'
       -- attname is of type name, not text — cast explicitly or the comparison
       -- fails with 42883 "operator does not exist: name[] = text[]".
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
              FROM unnest(c.conkey) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
           = ARRAY['vendorId']::text[]
       -- confkey too, not just conkey: without this, schema drift could match an
       -- FK pointing at some other unique Vendor column, which the rebuild below
       -- would then silently repoint at Vendor.id.
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
              FROM unnest(c.confkey) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
           = ARRAY['id']::text[];
`;

// pg_constraint stores the actions as single chars, not words.
const ACTION_BY_CODE = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

async function findVendorFk(client = prisma) {
    const rows = await client.$queryRawUnsafe(FIND_FK);
    if (rows.length !== 1) {
        throw new Error(`Expected exactly 1 PurchaseOrder.vendorId -> Vendor FK, found ${rows.length}`);
    }
    const row = rows[0];
    return {
        name: row.name,
        deleteAction: ACTION_BY_CODE[row.delete_type] ?? row.delete_type,
        updateAction: ACTION_BY_CODE[row.update_type] ?? row.update_type,
        validated: row.validated,
    };
}

async function main() {
    url = resolveDatabaseUrl();
    prisma = new PrismaClient({ datasources: { db: { url } } });
    console.log(`Applying to ${url.replace(/:[^:@]*@/, ":****@")}`);

    const fk = await findVendorFk();
    console.log(`  found FK ${fk.name}: ON DELETE ${fk.deleteAction}, ON UPDATE ${fk.updateAction}`);

    // Only done if it is BOTH restricted and validated. A first run that commits
    // the swap then dies before VALIDATE would otherwise leave the constraint
    // NOT VALID forever, with every rerun skipping straight past the fix.
    if (fk.deleteAction === "RESTRICT" && fk.validated) {
        console.log("Already RESTRICT and validated — nothing to do.");
        return;
    }

    if (fk.deleteAction === "RESTRICT") {
        console.log("  already RESTRICT but NOT VALID — resuming at validation.");
    } else {
        const [{ count: poCount }] = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS count FROM "PurchaseOrder";`,
        );
        console.log(`  ${poCount} purchase orders protected by this change`);
    }

    // One transaction: take the lock, re-check under it so two concurrent runs
    // cannot both rebuild the constraint, then swap the delete rule.
    // update action is carried over verbatim — only the delete rule changes.
    // Skipped entirely on the resume path so we don't take ACCESS EXCLUSIVE on a
    // live table just to discover there is nothing to swap.
    if (fk.deleteAction !== "RESTRICT") await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s';`);
        await tx.$executeRawUnsafe(`LOCK TABLE "public"."PurchaseOrder" IN ACCESS EXCLUSIVE MODE;`);

        const current = await findVendorFk(tx);
        if (current.deleteAction === "RESTRICT") {
            console.log("  another run got there first — nothing to do.");
            return;
        }

        await tx.$executeRawUnsafe(`ALTER TABLE "public"."PurchaseOrder" DROP CONSTRAINT "${current.name}";`);
        await tx.$executeRawUnsafe(
            `ALTER TABLE "public"."PurchaseOrder"
               ADD CONSTRAINT "${current.name}"
               FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id")
               ON DELETE RESTRICT ON UPDATE ${current.updateAction}
               NOT VALID;`,
        );
    });

    // Separate statement, weaker lock: re-checks existing rows without blocking
    // reads or writes. Every row already satisfied the old FK, so this cannot fail.
    const after = await findVendorFk();
    if (!after.validated) {
        console.log("  validating existing rows...");
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "public"."PurchaseOrder" VALIDATE CONSTRAINT "${after.name}";`,
        );
    }

    const final = await findVendorFk();
    if (final.deleteAction !== "RESTRICT") {
        throw new Error(`Verification failed: ON DELETE is ${final.deleteAction}, expected RESTRICT`);
    }
    if (final.updateAction !== fk.updateAction) {
        throw new Error(`Verification failed: ON UPDATE changed from ${fk.updateAction} to ${final.updateAction}`);
    }
    if (!final.validated) {
        throw new Error("Verification failed: constraint is still NOT VALID");
    }
    console.log(`${final.name} verified: ON DELETE RESTRICT, ON UPDATE ${final.updateAction}, validated.`);
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    main()
        .catch(error => {
            console.error(error);
            process.exitCode = 1;
        })
        .finally(() => prisma?.$disconnect());
}
