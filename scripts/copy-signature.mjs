import { PrismaClient } from "@prisma/client";

const ESTIMATE_ID = "cmnw712bs00018q3x7bbjc76j";
const BACKUP_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wcXVzemxoeXd1YndseWZqYmpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDcxMTMsImV4cCI6MjA5NDg4MzExM30.P8MR7Wzq2mPgyVLlkKoT0eZg3L4dx1nmVrRcCFEj6I4";
const BACKUP_URL = "https://npquszlhywubwlyfjbjo.supabase.co";

async function main() {
  console.log("Fetching signatureUrl from backup via REST API...");
  const url = `${BACKUP_URL}/rest/v1/Estimate?id=eq.${ESTIMATE_ID}&select=signatureUrl`;
  const res = await fetch(url, {
    headers: { apikey: BACKUP_ANON_KEY, Authorization: `Bearer ${BACKUP_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`REST API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const sigUrl = data[0]?.signatureUrl;
  if (!sigUrl) {
    console.error("No signatureUrl found in backup.");
    process.exit(1);
  }
  console.log(`  Got signatureUrl: ${sigUrl.length} chars`);

  console.log("\nUpdating production...");
  const prod = new PrismaClient();
  await prod.estimate.update({
    where: { id: ESTIMATE_ID },
    data: { signatureUrl: sigUrl },
  });

  const verify = await prod.estimate.findUnique({
    where: { id: ESTIMATE_ID },
    select: { signatureUrl: true },
  });
  console.log(`  Production signatureUrl: ${verify?.signatureUrl?.length ?? 0} chars`);
  console.log(verify?.signatureUrl?.length === sigUrl.length ? "  MATCH" : "  MISMATCH!");

  await prod.$disconnect();
  console.log("\nDone.");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
