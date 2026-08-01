// Map a Google Chat job space to a ProBuild project for the field-progress
// pipeline (chat-field-ingest reads Project.googleChatSpaceId).
//
//   node scripts/map-chat-space.mjs                              # list current mappings
//   node scripts/map-chat-space.mjs <projectId> spaces/XXXX      # set
//   node scripts/map-chat-space.mjs <projectId> --clear          # unset
//
// Known spaces (2026-07): Mesplay Team spaces/AAQAzYGXNtY, Mueller Team
// spaces/AAQANF47osY, Berg ADU Team spaces/AAQA__Z0qaA, Hoppe Team
// spaces/AAQA6CsBrzM.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env", ".env.local"]) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });
const [projectId, spaceArg] = process.argv.slice(2);

try {
  if (!projectId) {
    const mapped = await prisma.project.findMany({
      where: { googleChatSpaceId: { not: null } },
      select: { id: true, name: true, googleChatSpaceId: true, status: true },
    });
    if (mapped.length === 0) console.log("No projects mapped to Chat spaces yet.");
    for (const project of mapped) {
      console.log(`${project.googleChatSpaceId}  →  ${project.name} (${project.id}, ${project.status})`);
    }
  } else {
    if (!spaceArg) throw new Error("Usage: map-chat-space.mjs <projectId> <spaces/XXXX | --clear>");
    const googleChatSpaceId = spaceArg === "--clear" ? null : spaceArg;
    if (googleChatSpaceId && !/^spaces\/[A-Za-z0-9_-]+$/.test(googleChatSpaceId)) {
      throw new Error(`"${googleChatSpaceId}" doesn't look like a Chat space resource name (spaces/XXXX)`);
    }
    const project = await prisma.project.update({
      where: { id: projectId },
      data: { googleChatSpaceId },
      select: { name: true, googleChatSpaceId: true },
    });
    console.log(`✔ ${project.name}: googleChatSpaceId = ${project.googleChatSpaceId ?? "(cleared)"}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
