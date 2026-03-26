import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function timeTravel() {
    console.log("Searching for recently signed recurring contracts...");

    // Find a contract that is currently "Signed" and has recurringDays set
    const contract = await prisma.contract.findFirst({
        where: {
            status: 'Signed',
            recurringDays: { not: null },
            nextDueDate: { not: null }
        },
        orderBy: {
            updatedAt: 'desc'
        }
    });

    if (!contract) {
        console.log("❌ Whoops! I couldn't find any contract that is currently 'Signed' and set to 'Recurring'.");
        console.log("👉 Go sign a test recurring document first so we have something to Time Travel!");
        process.exit(1);
    }

    // Force the due date to be yesterday so the Cron Job strictly targets it
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    await prisma.contract.update({
        where: { id: contract.id },
        data: {
            nextDueDate: yesterday
        }
    });

    console.log(`\n✅ TIME TRAVEL SUCCESS!`);
    console.log(`Contract "${contract.title}" has been artificially fast-forwarded.`);
    console.log(`The system now thinks it was supposed to be signed yesterday (${yesterday.toLocaleDateString()}).`);
    console.log(`\n➡️ Now go click your CRON test link in to see the automation trigger!`);

    await prisma.$disconnect();
}

timeTravel().catch(console.error);
