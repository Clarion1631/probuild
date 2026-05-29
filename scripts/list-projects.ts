import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    console.log("=== LISTING PROJECTS ===");
    const projects = await prisma.project.findMany({
        select: {
            id: true,
            name: true,
            createdAt: true,
            status: true,
        },
        orderBy: {
            createdAt: "desc",
        }
    });

    console.log(`Total projects in DB: ${projects.length}`);
    projects.forEach((p, idx) => {
        console.log(`${idx + 1}. [${p.id}] ${p.name} (Created: ${p.createdAt.toISOString()}) [${p.status}]`);
    });

    console.log("=== LISTING LEADS ===");
    const leads = await prisma.lead.findMany({
        select: {
            id: true,
            name: true,
            createdAt: true,
            stage: true,
        },
        orderBy: {
            createdAt: "desc",
        }
    });
    console.log(`Total leads in DB: ${leads.length}`);
    leads.forEach((l, idx) => {
        console.log(`${idx + 1}. [${l.id}] ${l.name} (Created: ${l.createdAt.toISOString()}) [${l.stage}]`);
    });
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
