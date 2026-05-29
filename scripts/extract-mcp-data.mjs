/**
 * extract-mcp-data.mjs
 *
 * Queries the backup Supabase DB via the Management API and writes
 * clean JSON files for the restore script.
 *
 * Usage: SUPABASE_TOKEN=<token> node scripts/extract-mcp-data.mjs
 *
 * OR: provide the persisted MCP tool result file for items:
 *   node scripts/extract-mcp-data.mjs --from-file <items-file>
 */

import { readFileSync, writeFileSync } from "fs";

const BACKUP_REF = "npquszlhywubwlyfjbjo";
const ESTIMATE_ID = "cmnw712bs00018q3x7bbjc76j";
const PROJECT_ID = "cmnw6ztf60002ircciltw1h7c";
const LEAD_ID = "cmntnqf3w0002rx6f1ne5io7s";

function parseMcpToolResult(filePath) {
  const raw = readFileSync(filePath, "utf-8");
  const wrapper = JSON.parse(raw);
  const text = typeof wrapper === "string" ? wrapper : wrapper[0]?.text;
  const parsed = typeof text === "string" ? JSON.parse(text) : text;
  const resultStr = parsed.result || parsed;
  const match = String(resultStr).match(/<untrusted-data-[^>]+>\n([\s\S]*?)\n<\/untrusted-data/);
  if (!match) throw new Error("Could not parse data from " + filePath);
  return JSON.parse(match[1]);
}

async function queryBackup(sql) {
  const token = process.env.SUPABASE_TOKEN;
  if (!token) throw new Error("SUPABASE_TOKEN not set");

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${BACKUP_REF}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  return res.json();
}

async function main() {
  const fromFile = process.argv.includes("--from-file");

  let items, payments, files, tasks, budgets, folders, signatureUrl;

  if (fromFile) {
    const itemsFile = process.argv[process.argv.indexOf("--from-file") + 1];
    if (!itemsFile) {
      console.error("Provide the items MCP output file path after --from-file");
      process.exit(1);
    }
    console.log("Parsing items from MCP output file:", itemsFile);
    items = parseMcpToolResult(itemsFile);
    console.log(`  Parsed ${items.length} EstimateItems`);

    // For other data, we need to query the API or provide files
    console.log("Other data must be provided via separate --payments, --files, etc. flags");
    console.log("Or use API mode without --from-file");
    writeFileSync("scripts/mesplay-items.json", JSON.stringify(items, null, 2));
    console.log("Wrote scripts/mesplay-items.json");
    return;
  }

  // API mode - query everything
  console.log("Querying backup via Supabase Management API...");

  console.log("  EstimateItems...");
  items = await queryBackup(
    `SELECT * FROM "EstimateItem" WHERE "estimateId" = '${ESTIMATE_ID}' ORDER BY "order" ASC`
  );
  writeFileSync("scripts/mesplay-items.json", JSON.stringify(items, null, 2));
  console.log(`    ${items.length} items`);

  console.log("  PaymentSchedules...");
  payments = await queryBackup(
    `SELECT * FROM "EstimatePaymentSchedule" WHERE "estimateId" = '${ESTIMATE_ID}' ORDER BY "order" ASC`
  );
  writeFileSync("scripts/mesplay-payments.json", JSON.stringify(payments, null, 2));
  console.log(`    ${payments.length} payments`);

  console.log("  ProjectFiles...");
  files = await queryBackup(
    `SELECT * FROM "ProjectFile" WHERE "projectId" = '${PROJECT_ID}' OR "leadId" = '${LEAD_ID}'`
  );
  writeFileSync("scripts/mesplay-files.json", JSON.stringify(files, null, 2));
  console.log(`    ${files.length} files`);

  console.log("  ScheduleTasks...");
  tasks = await queryBackup(
    `SELECT * FROM "ScheduleTask" WHERE "projectId" = '${PROJECT_ID}' OR "leadId" = '${LEAD_ID}' ORDER BY "order" ASC`
  );
  writeFileSync("scripts/mesplay-tasks.json", JSON.stringify(tasks, null, 2));
  console.log(`    ${tasks.length} tasks`);

  console.log("  Budget...");
  budgets = await queryBackup(
    `SELECT * FROM "Budget" WHERE "projectId" = '${PROJECT_ID}'`
  );
  writeFileSync("scripts/mesplay-budgets.json", JSON.stringify(budgets, null, 2));
  console.log(`    ${budgets.length} budgets`);

  console.log("  FileFolders...");
  folders = await queryBackup(
    `SELECT * FROM "FileFolder" WHERE "projectId" = '${PROJECT_ID}'`
  );
  writeFileSync("scripts/mesplay-folders.json", JSON.stringify(folders, null, 2));
  console.log(`    ${folders.length} folders`);

  console.log("  SignatureUrl...");
  const sigResult = await queryBackup(
    `SELECT "signatureUrl" FROM "Estimate" WHERE "id" = '${ESTIMATE_ID}'`
  );
  writeFileSync("scripts/mesplay-signature.txt", sigResult[0].signatureUrl);
  console.log(`    ${sigResult[0].signatureUrl.length} chars`);

  console.log("\nAll data extracted successfully!");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
