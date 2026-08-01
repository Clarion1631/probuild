// One-off backfill for the Automation Command Center: the AutomationEvent log
// only started recording at deploy time, so history is empty. Every QBO
// Purchase carrying our [gtr-file:<driveFileId>] idempotency marker was
// created by the receipt pipeline — reconstruct a "receipt-push / created"
// event for each so journeys, the intake graph, and month totals show the
// real history.
//
// Idempotent: skips any docNumber that already has a receipt-push event.
// Backfilled rows are marked detail.backfilled=true and source "backfill".
//
//   ENV_FILE=<path> node scripts/backfill-automation-events.mjs
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

// ── QBO client riding ProBuild's stored OAuth connection (mirror of lib/crypto) ──
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

const TAX_ACCOUNT_ID = env.QBO_RECEIPT_TAX_ACCOUNT_ID || "1150040032";

// PrivateNote is NOT queryable in QBO SQL — pull the window and filter for
// our marker client-side. Window by CREATION time, not TxnDate: a receipt
// pushed after launch can carry an earlier transaction date (backdated
// paper receipt) and must still be found. Markers cannot predate the API
// push launch (2026-07-31), so this bound is exact.
const purchases = [];
for (let start = 1; ; start += 100) {
  const page = await qbQuery(
    `SELECT * FROM Purchase WHERE MetaData.CreateTime >= '2026-07-31T00:00:00-08:00' STARTPOSITION ${start} MAXRESULTS 100`,
  );
  const rows = page?.Purchase ?? [];
  purchases.push(...rows.filter(p => (p.PrivateNote ?? "").includes("[gtr-file:")));
  if (rows.length < 100) break;
}
console.log(`marked purchases in QBO (created since launch): ${purchases.length}`);

let inserted = 0, skippedExisting = 0, skippedUnparseable = 0;
for (const p of purchases) {
  const m = (p.PrivateNote ?? "").match(/\[gtr-file:([^\]]+)\]/);
  if (!m) { skippedUnparseable += 1; continue; }
  const fileId = m[1];
  const docNumber = fileId.slice(0, 21);

  // Skip only when SUCCESSFUL evidence exists — a lone transient "error"
  // event must not block reconstructing the booking the marker proves.
  const existing = await prisma.automationEvent.findFirst({
    where: { kind: "receipt-push", docNumber, status: { in: ["created", "already-exists"] } },
    select: { id: true },
  });
  if (existing) { skippedExisting += 1; continue; }

  const lines = Array.isArray(p.Line) ? p.Line : [];
  const expenseLines = lines.filter(l => l?.DetailType === "AccountBasedExpenseLineDetail");
  const taxCents = expenseLines
    .filter(l => String(l.AccountBasedExpenseLineDetail?.AccountRef?.value) === TAX_ACCOUNT_ID)
    .reduce((sum, l) => sum + Math.round(Number(l.Amount || 0) * 100), 0);
  const projectName = expenseLines
    .map(l => l.AccountBasedExpenseLineDetail?.CustomerRef?.name)
    .find(Boolean) ?? null;
  const createdAt = p.MetaData?.CreateTime ? new Date(p.MetaData.CreateTime) : new Date(`${p.TxnDate}T12:00:00Z`);

  await prisma.automationEvent.create({
    data: {
      kind: "receipt-push",
      status: "created",
      source: "backfill",
      vendor: p.EntityRef?.name ?? null,
      projectName,
      docNumber,
      fileName: null,
      amountCents: Number.isFinite(Number(p.TotalAmt)) ? Math.round(Number(p.TotalAmt) * 100) : null,
      taxCents: taxCents > 0 ? taxCents : null,
      detail: JSON.stringify({ fileId, qbPurchaseId: p.Id, backfilled: true, txnDate: p.TxnDate }),
      createdAt: Number.isFinite(createdAt.getTime()) ? createdAt : new Date(),
    },
  });
  inserted += 1;
}

console.log(`backfill done: inserted=${inserted} already-present=${skippedExisting} unparseable=${skippedUnparseable}`);
await prisma.$disconnect();
