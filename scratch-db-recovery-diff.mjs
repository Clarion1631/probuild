import { PrismaClient } from "@prisma/client";

const sourceUrl = "postgresql://postgres.npquszlhywubwlyfjbjo:1QhFQ7SWtXtOaVqD@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true";
const targetUrl = "postgresql://postgres.ghzdbzdnwjxazvmcefbh:ZEk.H65KV%2FEAkTV@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true";

const prismaSource = new PrismaClient({
  datasources: { db: { url: sourceUrl } }
});

const prismaTarget = new PrismaClient({
  datasources: { db: { url: targetUrl } }
});

async function runDiff() {
  console.log("Connecting to both databases...");
  
  const tables = [
    "Client",
    "Project",
    "Lead",
    "Estimate",
    "EstimateItem",
    "Invoice",
    "TimeEntry",
    "Expense"
  ];

  console.log("\n--- DATABASE DIFFERENTIAL REPORT ---");

  for (const table of tables) {
    const delegate = table.charAt(0).toLowerCase() + table.slice(1);
    try {
      if (typeof prismaSource[delegate]?.findMany !== "function") {
        continue;
      }
      
      const sourceRecords = await prismaSource[delegate].findMany({
        select: { id: true }
      });
      const targetRecords = await prismaTarget[delegate].findMany({
        select: { id: true }
      });

      const sourceIds = new Set(sourceRecords.map(r => r.id));
      const targetIds = new Set(targetRecords.map(r => r.id));

      const missingInTarget = [...sourceIds].filter(id => !targetIds.has(id));

      console.log(`${table}:`);
      console.log(`  - Backup: ${sourceRecords.length} records`);
      console.log(`  - Active Live: ${targetRecords.length} records`);
      console.log(`  - MISSING IN ACTIVE LIVE: ${missingInTarget.length} records`);

      if (missingInTarget.length > 0) {
        // Fetch some sample detail of missing records
        let sampleQuery = {
          where: { id: { in: missingInTarget.slice(0, 5) } }
        };
        
        // Custom select for better readability based on table fields
        if (table === "Client") {
          sampleQuery.select = { id: true, name: true, email: true };
        } else if (table === "Project") {
          sampleQuery.select = { id: true, name: true, status: true };
        } else if (table === "Lead") {
          sampleQuery.select = { id: true, name: true, status: true };
        } else if (table === "Estimate") {
          sampleQuery.select = { id: true, title: true, status: true, totalAmount: true };
        } else if (table === "Invoice") {
          sampleQuery.select = { id: true, totalAmount: true, balanceDue: true, status: true };
        } else if (table === "EstimateItem") {
          sampleQuery.select = { id: true, name: true, total: true };
        }

        const samples = await prismaSource[delegate].findMany(sampleQuery);
        console.log(`  - Sample missing records:`, JSON.stringify(samples, null, 2));
      }
    } catch (err) {
      console.error(`Error comparing ${table}:`, err.message);
    }
  }
}

runDiff()
  .catch(console.error)
  .finally(async () => {
    await prismaSource.$disconnect();
    await prismaTarget.$disconnect();
  });
