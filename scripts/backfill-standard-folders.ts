// Backfill the standard project folder scaffold.
//
// Scoped to IN PROGRESS projects by default (Justin, 2026-07-29). A blanket run
// covers 78 projects — including long-closed jobs and obvious junk rows like
// "Richard Test1" and "Wendy text" — which is 624 folders of clutter nobody
// opens. Everything outside the scope still gets its scaffold lazily, the first
// time the MCP touches that project.
//
// Dry-run is the default:
//   npx tsx scripts/backfill-standard-folders.ts
//
// Apply only after reviewing the dry-run:
//   npx tsx scripts/backfill-standard-folders.ts --write
//
// Widen the scope deliberately:
//   npx tsx scripts/backfill-standard-folders.ts --all
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

import {
  STANDARD_PROJECT_FOLDERS,
  ensureStandardFolders,
} from "../src/lib/project-folders";

function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env", ".env.local"]) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const write = process.argv.includes("--write");
const allProjects = process.argv.includes("--all");
const prisma = new PrismaClient({
  datasources: { db: { url: resolveDatabaseUrl() } },
});

// Wrapped in main() rather than using top-level await: tsx emits CJS under this
// repo's tsconfig, and top-level await is a hard transform error there.
async function main() {
  const projects = await prisma.project.findMany({
    where: allProjects ? {} : { status: "In Progress" },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      folders: {
        where: { parentId: null },
        select: { name: true },
      },
    },
  });

  let totalMissing = 0;
  for (const project of projects) {
    const existing = new Set(project.folders.map(folder => folder.name.trim().toLocaleLowerCase()));
    const missing = STANDARD_PROJECT_FOLDERS.filter(name => !existing.has(name.toLocaleLowerCase()));
    totalMissing += missing.length;
    console.log(
      `${project.name} (${project.id}): ${missing.length > 0 ? missing.join(" | ") : "(complete)"}`,
    );
    if (write && missing.length > 0) {
      await ensureStandardFolders(project.id, prisma);
    }
  }

  const scope = allProjects ? "ALL projects" : 'projects with status "In Progress"';
  console.log(
    write
      ? `WRITE complete (${scope}): ensured the scaffold on ${projects.length} projects (${totalMissing} folders were missing before the run).`
      : `DRY-RUN (${scope}): ${totalMissing} folders would be created across ${projects.length} projects. Re-run with --write to apply.`,
  );
}

main()
  .catch(error => {
    console.error("Standard-folder backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
