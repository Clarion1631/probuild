import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
    const defaultTags = ["Plumbing", "Electrical", "HVAC", "Framing", "General", "Drywall", "Painting"];
    let added = 0;
    
    for (const tagName of defaultTags) {
        // use upsert to avoid duplicates
        const exists = await prisma.vendorTag.findFirst({ where: { name: tagName } });
        if (!exists) {
            await prisma.vendorTag.create({ data: { name: tagName } });
            added++;
        }
    }
    console.log(`Successfully seeded ${added} initial Vendor Tags.`);
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
