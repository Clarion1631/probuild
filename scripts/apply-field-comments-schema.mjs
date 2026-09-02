import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const statements = [
    `CREATE TABLE IF NOT EXISTS "TaskCommentPhoto" (
        "id" TEXT PRIMARY KEY,
        "commentId" TEXT NOT NULL,
        "url" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "TaskCommentPhoto_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "TaskComment"("id") ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS "TaskCommentPhoto_commentId_idx" ON "TaskCommentPhoto" ("commentId")`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "fieldUpdatesSeenAt" TIMESTAMP(3)`,
];

async function main() {
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    try {
        for (const sql of statements) {
            await prisma.$executeRawUnsafe(sql);
            console.log("OK:", sql.split("\n")[0].slice(0, 80));
        }
        console.log("\nMigration applied successfully");
    } catch (e) {
        console.error("Migration failed:", e);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
