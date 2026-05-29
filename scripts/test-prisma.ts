import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    console.log("=== DB QUERY START ===");
    
    const project = await prisma.project.findFirst({
        where: { name: "Adkins Kitchen" },
        include: {
            estimates: {
                include: {
                    paymentSchedules: true,
                }
            }
        }
    });

    if (project) {
        console.log("Found Adkins Kitchen project!");
        console.log("Project ID:", project.id);
        console.log("Estimates count:", project.estimates.length);
        for (const est of project.estimates) {
            console.log(`\nEstimate ID: ${est.id}`);
            console.log(`Title: ${est.title}`);
            console.log(`Status: ${est.status}`);
            console.log("Schedules:", JSON.stringify(est.paymentSchedules, null, 2));
        }
    } else {
        console.log("Adkins Kitchen project NOT found!");
    }

    console.log("=== DB QUERY END ===");
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
