import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log("Connecting to database and creating indexes...");

    const sqls = [
        `CREATE INDEX IF NOT EXISTS "ScheduleTask_projectId_idx" ON "ScheduleTask"("projectId")`,
        `CREATE INDEX IF NOT EXISTS "ScheduleTask_leadId_idx" ON "ScheduleTask"("leadId")`,
        `CREATE INDEX IF NOT EXISTS "DailyLog_projectId_idx" ON "DailyLog"("projectId")`,
        `CREATE INDEX IF NOT EXISTS "ChangeOrder_projectId_idx" ON "ChangeOrder"("projectId")`,
        
        `CREATE INDEX IF NOT EXISTS "Contract_projectId_idx" ON "Contract"("projectId")`,
        `CREATE INDEX IF NOT EXISTS "Contract_leadId_idx" ON "Contract"("leadId")`,
        
        `CREATE INDEX IF NOT EXISTS "ContractSigningRecord_contractId_idx" ON "ContractSigningRecord"("contractId")`,
        
        `CREATE INDEX IF NOT EXISTS "FileFolder_projectId_idx" ON "FileFolder"("projectId")`,
        `CREATE INDEX IF NOT EXISTS "FileFolder_leadId_idx" ON "FileFolder"("leadId")`,
        `CREATE INDEX IF NOT EXISTS "FileFolder_parentId_idx" ON "FileFolder"("parentId")`,
        
        `CREATE INDEX IF NOT EXISTS "PurchaseOrder_projectId_idx" ON "PurchaseOrder"("projectId")`,
        `CREATE INDEX IF NOT EXISTS "PurchaseOrder_vendorId_idx" ON "PurchaseOrder"("vendorId")`,
        
        `CREATE INDEX IF NOT EXISTS "PurchaseOrderItem_purchaseOrderId_idx" ON "PurchaseOrderItem"("purchaseOrderId")`,
        
        `CREATE INDEX IF NOT EXISTS "SelectionBoard_projectId_idx" ON "SelectionBoard"("projectId")`,
        `CREATE INDEX IF NOT EXISTS "MoodBoard_projectId_idx" ON "MoodBoard"("projectId")`,
        
        `CREATE INDEX IF NOT EXISTS "Retainer_projectId_idx" ON "Retainer"("projectId")`,
        `CREATE INDEX IF NOT EXISTS "Retainer_clientId_idx" ON "Retainer"("clientId")`,
        
        `CREATE INDEX IF NOT EXISTS "BidPackage_projectId_idx" ON "BidPackage"("projectId")`,
        
        `CREATE INDEX IF NOT EXISTS "TimeEntry_costCodeId_idx" ON "TimeEntry"("costCodeId")`,
        `CREATE INDEX IF NOT EXISTS "TimeEntry_costTypeId_idx" ON "TimeEntry"("costTypeId")`,
        `CREATE INDEX IF NOT EXISTS "TimeEntry_estimateItemId_idx" ON "TimeEntry"("estimateItemId")`,
        `CREATE INDEX IF NOT EXISTS "TimeEntry_scheduleTaskId_idx" ON "TimeEntry"("scheduleTaskId")`
    ];

    for (const sql of sqls) {
        console.log(`Executing: ${sql}`);
        const result = await prisma.$executeRawUnsafe(sql);
        console.log(`Result: ${result}`);
    }

    console.log("Successfully created all indexes!");
}

main()
    .catch((err) => {
        console.error("Error creating indexes:", err);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
