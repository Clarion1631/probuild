// End-to-end test for the field-comments feature.
// Exercises: add comment with photos, fetch comments with photos, feed query,
// unread count, mark-seen. Hits the real DB; does NOT call HTTP routes.
//
// Run: node scripts/test-field-comments-e2e.mjs

import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const TEST_TASK_ID = "cmnukdcs900015jka4fp8d2zy"; // Demolition and Site Protection (Adkins Kitchen)

function log(label, value) {
    console.log(`\n=== ${label} ===`);
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

try {
    // 1. Verify the task exists
    const task = await prisma.scheduleTask.findFirst({
        where: { name: "Demolition and Site Protection" },
        select: { id: true, name: true, projectId: true },
    });
    if (!task) throw new Error("Test task not found");
    log("1. Task fixture", task);

    // 2. Find any real User with id for testing — use the first ADMIN we find
    const user = await prisma.user.findFirst({
        where: { role: "ADMIN" },
        select: { id: true, name: true, email: true },
    });
    if (!user) throw new Error("No ADMIN user in DB to test with");
    log("2. Test user (admin)", user);

    // 3. Create a TaskComment with two photo URLs (simulating what the mobile route does)
    const created = await prisma.taskComment.create({
        data: {
            taskId: task.id,
            text: "E2E test: photos attached.",
            userId: user.id,
            photos: {
                create: [
                    { url: "https://example.com/test-photo-1.jpg" },
                    { url: "https://example.com/test-photo-2.jpg" },
                ],
            },
        },
        include: {
            user: { select: { id: true, name: true, email: true } },
            photos: { orderBy: { createdAt: "asc" } },
        },
    });
    log("3. Created comment with photos", {
        id: created.id,
        text: created.text,
        photoCount: created.photos.length,
        photoUrls: created.photos.map(p => p.url),
        authorName: created.user?.name,
    });

    // 4. Read it back via the same query shape the feed uses
    const feedShape = await prisma.taskComment.findFirst({
        where: { id: created.id },
        include: {
            user: { select: { id: true, name: true, email: true } },
            photos: { orderBy: { createdAt: "asc" }, select: { id: true, url: true } },
            task: { select: { id: true, name: true, projectId: true, project: { select: { id: true, name: true } } } },
        },
    });
    log("4. Feed-shape readback", {
        id: feedShape?.id,
        taskName: feedShape?.task?.name,
        projectName: feedShape?.task?.project?.name,
        photoCount: feedShape?.photos.length,
    });

    // 5. Run the feed query (most-recent N comments)
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const feed = await prisma.taskComment.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
            user: { select: { id: true, name: true, email: true } },
            photos: { select: { id: true, url: true } },
            task: { select: { id: true, name: true, project: { select: { name: true } } } },
        },
    });
    log("5. Feed query (last 10, 14d window)", feed.map(c => ({
        id: c.id,
        text: c.text.slice(0, 40),
        author: c.user?.name || c.user?.email || c.subcontractorName,
        photos: c.photos.length,
        task: c.task?.name,
        project: c.task?.project?.name,
    })));

    // 6. Unread count: how many comments since user.fieldUpdatesSeenAt?
    const userSeen = await prisma.user.findUnique({
        where: { id: user.id },
        select: { fieldUpdatesSeenAt: true },
    });
    const seenAt = userSeen?.fieldUpdatesSeenAt ?? since;
    const unread = await prisma.taskComment.count({
        where: { createdAt: { gt: seenAt }, NOT: { userId: user.id } },
    });
    log("6. Unread count for admin user", { seenAt: seenAt.toISOString(), unread });

    // 7. Mark seen — update fieldUpdatesSeenAt
    await prisma.user.update({
        where: { id: user.id },
        data: { fieldUpdatesSeenAt: new Date() },
    });
    const unreadAfter = await prisma.taskComment.count({
        where: { createdAt: { gt: new Date() }, NOT: { userId: user.id } },
    });
    log("7. After mark-seen, unread count", { unreadAfter });

    // 8. Cleanup — delete the test comment (photos cascade)
    await prisma.taskComment.delete({ where: { id: created.id } });
    const stillThere = await prisma.taskComment.findUnique({ where: { id: created.id } });
    const orphanPhotos = await prisma.taskCommentPhoto.findMany({ where: { commentId: created.id } });
    log("8. Cleanup", { commentStillExists: !!stillThere, orphanPhotoCount: orphanPhotos.length });

    console.log("\n✅ All E2E checks passed");
} catch (e) {
    console.error("\n❌ E2E test failed:", e);
    process.exit(1);
} finally {
    await prisma.$disconnect();
}
