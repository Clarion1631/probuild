// Mints a per-person MCP connector key (McpKey) for a ProBuild user.
// The raw key is generated here and printed once — only its sha256 hash is
// stored, so it can never be recovered after this run.
//
// Usage:
//   node scripts/mint-mcp-key.mjs <user-email> "<label>"
//   node scripts/mint-mcp-key.mjs --revoke <keyId>
//   node scripts/mint-mcp-key.mjs --list
//
// DO NOT RUN as part of implementation handoff — this writes to the live
// database. Run it only when actually issuing/revoking a connector key.
import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";
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

const prisma = new PrismaClient({
  datasources: { db: { url: resolveDatabaseUrl() } },
});

function usage() {
  console.error(
    "Usage:\n" +
      '  node scripts/mint-mcp-key.mjs <user-email> "<label>"\n' +
      "  node scripts/mint-mcp-key.mjs --revoke <keyId>\n" +
      "  node scripts/mint-mcp-key.mjs --list"
  );
}

async function listKeys() {
  const keys = await prisma.mcpKey.findMany({
    orderBy: { createdAt: "desc" },
    include: { user: { select: { email: true, name: true } } },
  });
  if (keys.length === 0) {
    console.log("No MCP keys minted yet.");
    return;
  }
  for (const k of keys) {
    console.log(
      `${k.id}  ${k.label}  user=${k.user.name ?? k.user.email} <${k.user.email}>  ` +
        `created=${k.createdAt.toISOString()}  lastUsed=${k.lastUsedAt ? k.lastUsedAt.toISOString() : "never"}  ` +
        `revoked=${k.revokedAt ? k.revokedAt.toISOString() : "no"}`
    );
  }
}

async function revokeKey(keyId) {
  const existing = await prisma.mcpKey.findUnique({ where: { id: keyId } });
  if (!existing) {
    console.error(`No McpKey with id ${keyId}`);
    process.exitCode = 1;
    return;
  }
  if (existing.revokedAt) {
    console.log(`Key ${keyId} (${existing.label}) is already revoked as of ${existing.revokedAt.toISOString()}.`);
    return;
  }
  await prisma.mcpKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
  console.log(`Revoked key ${keyId} (${existing.label}).`);
}

async function mintKey(email, label) {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });
  if (!user) {
    console.error(`No user found with email ${email}`);
    process.exitCode = 1;
    return;
  }
  if (user.status === "DISABLED") {
    console.error(`User ${email} is DISABLED — cannot mint a connector key for a disabled user.`);
    process.exitCode = 1;
    return;
  }

  const rawKey = randomBytes(32).toString("hex");
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  await prisma.mcpKey.create({
    data: { label, keyHash, userId: user.id },
  });

  const url = `https://probuild.goldentouchremodeling.com/api/mcp/mcp?key=${rawKey}`;
  console.log(`Label: ${label}`);
  console.log(`User:  ${user.name ?? user.email} <${user.email}>`);
  console.log(`Connector URL: ${url}`);
  console.log("This raw key is NOT recoverable — send it to the user over a private channel.");
}

async function main() {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--list") {
      await listKeys();
      return;
    }
    if (args[0] === "--revoke") {
      const keyId = args[1];
      if (!keyId) {
        usage();
        process.exitCode = 1;
        return;
      }
      await revokeKey(keyId);
      return;
    }
    const [email, label] = args;
    if (!email || !label) {
      usage();
      process.exitCode = 1;
      return;
    }
    await mintKey(email, label);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
