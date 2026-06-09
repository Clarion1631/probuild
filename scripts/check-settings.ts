import { PrismaClient } from '@prisma/client';
import { decryptObject } from '../src/lib/crypto';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const prisma = new PrismaClient();

async function main() {
    const row = await prisma.integration.findUnique({
        where: { id: "system_settings" }
    });
    if (!row) {
        console.log("No integration row found!");
        return;
    }
    console.log("Found integration row. Encrypted settings length:", row.settings.length);
    try {
        const parsed = decryptObject(row.settings);
        console.log("Decrypted settings:", JSON.stringify(parsed, null, 2));
    } catch (err: any) {
        console.log("Failed to decrypt settings using current NEXTAUTH_SECRET! Error:", err.message);
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
