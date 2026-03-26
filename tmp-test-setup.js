const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function preparePerfectTest() {
    console.log("Setting up the perfect 'Time Travel' test scenario for you...");

    // 1. Find a real Lead
    const lead = await prisma.lead.findFirst({
        orderBy: { createdAt: 'desc' }
    });

    if (!lead) {
        console.log("No leads found in database!");
        process.exit(1);
    }
    console.log(`✅ Using Lead: ${lead.name} (${lead.id})`);

    // 2. Create an executed Recurring Contract for this Lead
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    const signedLastMonth = new Date();
    signedLastMonth.setDate(signedLastMonth.getDate() - 31);

    const contract = await prisma.contract.create({
        data: {
            title: `Automated Test Lien Release - ${Date.now()}`,
            body: `<p>This is a test recurring contract executed 30 days ago.</p> <div class="doc-block-btn sig-block" data-id="sig-0">[ Click to Sign ]</div>`,
            status: "Signed",
            leadId: lead.id,
            companyId: lead.companyId,
            
            sentAt: signedLastMonth,
            approvedBy: "Justin (Test Client)",
            approvedAt: signedLastMonth,
            
            recurringDays: 30,
            nextDueDate: yesterday
        }
    });

    // Seed the first signature record
    await prisma.contractSigningRecord.create({
        data: {
            contractId: contract.id,
            signedBy: "Justin (Test Client)",
            signedAt: signedLastMonth,
            periodStart: signedLastMonth,
            periodEnd: yesterday,
            signatureUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" // tiny pixel
        }
    });

    console.log(`✅ Forged a 30-day-old signed contract (ID: ${contract.id})`);
    console.log(`\n=========================================`);
    console.log(`TEST READY!`);
    console.log(`Lead Name: ${lead.name}`);
    console.log(`Lead URL: /leads/${lead.id}`);
    console.log(`=========================================\n`);

    await prisma.$disconnect();
}

preparePerfectTest().catch(console.error);
