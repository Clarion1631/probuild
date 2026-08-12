// One-off backfill for the Vanessa review loop (Goal 2): Expense.qboCreateTime
// only gets written going forward by the sync (src/lib/qbo-expense-sync.ts).
// Rows imported before that column existed have qboCreateTime = null — batch
// fetch each Purchase's MetaData.CreateTime from QBO and fill it in.
//
// Idempotent: only touches Expense rows where qbPurchaseId is set and
// qboCreateTime is still null. Purchases no longer found in QBO (deleted)
// are skipped, not errored.
//
//   ENV_FILE=<path> node scripts/backfill-qbo-create-time.mjs
//
// Needs DATABASE_URL, NEXTAUTH_SECRET, QB_CLIENT_ID, QB_CLIENT_SECRET.
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import fs from "node:fs";

const env = { ...process.env };
for (const file of [process.env.ENV_FILE, ".env", ".env.local"].filter(Boolean)) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
}
for (const k of ["DATABASE_URL", "NEXTAUTH_SECRET", "QB_CLIENT_ID", "QB_CLIENT_SECRET"]) {
  if (!env[k]) { console.error("missing env " + k); process.exit(1); }
}

const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });

// ── QBO client riding ProBuild's stored OAuth connection (mirror of
// backfill-automation-events.mjs / lib/crypto) ──
const key = crypto.createHash("sha256").update(env.NEXTAUTH_SECRET).digest();
function dec(s) {
  const [iv, ct, tag] = s.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return JSON.parse(d.update(ct, "hex", "utf8") + d.final("utf8"));
}
function enc(o) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = c.update(JSON.stringify(o), "utf8", "hex") + c.final("hex");
  return `${iv.toString("hex")}:${ct}:${c.getAuthTag().toString("hex")}`;
}

const settingsRow = await prisma.integration.findUnique({ where: { id: "system_settings" } });
if (!settingsRow?.settings) { console.error("no integration row"); process.exit(1); }
const settings = dec(settingsRow.settings);
const qb = settings.quickbooks;
if (!qb?.connected || !qb.refreshToken || !qb.realmId) { console.error("QB not connected"); process.exit(1); }

const API = "https://quickbooks.api.intuit.com/v3/company";
async function refreshToken() {
  const basic = Buffer.from(`${env.QB_CLIENT_ID}:${env.QB_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: qb.refreshToken }),
  });
  if (!res.ok) throw new Error("token refresh failed: " + res.status);
  const d = await res.json();
  settings.quickbooks = { ...qb, accessToken: d.access_token, refreshToken: d.refresh_token };
  qb.accessToken = d.access_token; qb.refreshToken = d.refresh_token;
  await prisma.integration.update({ where: { id: "system_settings" }, data: { settings: enc(settings) } });
  console.error("[token refreshed + persisted]");
}
async function qbQuery(query) {
  const url = `${API}/${qb.realmId}/query?query=${encodeURIComponent(query)}&minorversion=73`;
  let res = await fetch(url, { headers: { Authorization: `Bearer ${qb.accessToken}`, Accept: "application/json" } });
  if (res.status === 401) { await refreshToken(); res = await fetch(url, { headers: { Authorization: `Bearer ${qb.accessToken}`, Accept: "application/json" } }); }
  if (!res.ok) throw new Error(`QBO ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).QueryResponse;
}

const BATCH_SIZE = 30; // stays well under QBO's query URL length limit

const pending = await prisma.expense.findMany({
  where: { qbPurchaseId: { not: null }, qboCreateTime: null },
  select: { id: true, qbPurchaseId: true },
});
console.log(`expenses missing qboCreateTime: ${pending.length}`);

let updated = 0, notFoundInQbo = 0, unparseable = 0;
for (let i = 0; i < pending.length; i += BATCH_SIZE) {
  const batch = pending.slice(i, i + BATCH_SIZE);
  const ids = batch.map(e => `'${e.qbPurchaseId.replace(/'/g, "\\'")}'`).join(",");
  const page = await qbQuery(`SELECT Id, MetaData FROM Purchase WHERE Id IN (${ids}) MAXRESULTS ${BATCH_SIZE}`);
  const byId = new Map((page?.Purchase ?? []).map(p => [String(p.Id), p]));

  for (const expense of batch) {
    const purchase = byId.get(expense.qbPurchaseId);
    if (!purchase) { notFoundInQbo += 1; continue; }
    const createTime = purchase.MetaData?.CreateTime;
    if (!createTime) { unparseable += 1; continue; }
    const createdAt = new Date(createTime);
    if (!Number.isFinite(createdAt.getTime())) { unparseable += 1; continue; }
    await prisma.expense.update({
      where: { id: expense.id },
      data: { qboCreateTime: createdAt },
    });
    updated += 1;
  }
  console.log(`  batch ${i / BATCH_SIZE + 1}: updated=${updated} not-found=${notFoundInQbo} unparseable=${unparseable}`);
}

console.log(`backfill done: updated=${updated} not-found-in-qbo=${notFoundInQbo} unparseable=${unparseable}`);
await prisma.$disconnect();
