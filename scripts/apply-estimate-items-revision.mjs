// Adds Estimate.itemsRevision — the optimistic-concurrency guard for the estimate editor's save
// path (docs/specs/estimate-item-optimistic-concurrency.md, REVISION 2). Two people with the
// same estimate open used to have the second save silently overwrite the first's edits (or, for
// adds/deletes/wholesale rewrites, silently revert them); saveEstimate now compare-and-sets on
// this single estimate-level revision.
//
// Additive and idempotent: safe to run against prod while the old build is live. Run this
// BEFORE deploying the build that selects the column, or estimate-reading pages throw P2022
// "column does not exist".
//
// Usage: node scripts/apply-estimate-items-revision.mjs
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// Same resolution the sibling apply-*.mjs scripts use: env first, then the
// checked-out .env files, since these are run by hand rather than by Next.
function resolveDatabaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    for (const file of [".env", ".env.local"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return match[1];
    }
    throw new Error("DATABASE_URL not found in env or .env files");
}

let url;
let prisma;

const STATEMENTS = [
    `ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "itemsRevision" INTEGER NOT NULL DEFAULT 0;`,
];

async function main() {
    url = resolveDatabaseUrl();
    prisma = new PrismaClient({ datasources: { db: { url } } });

    console.log(`Applying to ${url.replace(/:[^:@]*@/, ":****@")}`);

    for (const sql of STATEMENTS) {
        console.log(`  ${sql}`);
        await prisma.$executeRawUnsafe(sql);
    }

    const [{ count }] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM information_schema.columns
          WHERE table_name = 'Estimate' AND column_name = 'itemsRevision';`,
    );
    if (count !== 1) throw new Error(`Verification failed: itemsRevision column count = ${count}`);
    console.log("Estimate.itemsRevision column verified.");
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
