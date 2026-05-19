import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log("Connecting to database and creating indexes...");

    const sqls = [
        `CREATE INDEX IF NOT EXISTS "ScheduleTask_projectId_idx" ON "ScheduleTask"("projectId")`,
        `CREATE INDEX IF NOT EXISTS "ScheduleTask_leadId_idx" ON "ScheduleTask"("leadId")`,
        `CREATE INDEX IF NOT EXISTS "DailyLog_projectId_idx" ON "DailyLog"("projectId")`,
        `CREATE INDEX IF NOT EXISTS "ChangeOrder_projectId_idx" ON "ChangeOrder"("projectId")`
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
