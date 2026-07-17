// Read-only pre-deploy probe: confirm every new column referenced by the uncommitted
// features actually exists in the DB, so we don't deploy code that queries missing columns.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of [".env", ".env.local"]) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  throw new Error("DATABASE_URL not found");
}

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

const expected = {
  Contract: ["requiresCountersign", "companySignedBy", "companySignedAt", "companySignatureUrl", "signedPdfPath"],
  CompanySettings: ["requireContractCountersign"],
  ChangeOrder: ["companySignedBy", "companySignedAt", "companySignatureUrl"],
};

try {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name IN ('Contract','CompanySettings','ChangeOrder')
  `);
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  let allOk = true;
  for (const [table, cols] of Object.entries(expected)) {
    for (const c of cols) {
      const key = `${table}.${c}`;
      const ok = have.has(key);
      if (!ok) allOk = false;
      console.log(`${ok ? "✔" : "✗ MISSING"}  ${key}`);
    }
  }
  console.log(allOk ? "\nALL PRESENT — safe to deploy" : "\nMISSING COLUMNS — do NOT deploy until applied");
} catch (e) {
  console.error("probe failed:", e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
