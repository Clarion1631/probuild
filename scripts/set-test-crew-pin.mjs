// Sets a PIN on the EXISTING "Test Field Crew" prod user so the crew clock-in
// flow can be visually verified in a browser. Approved by Justin 2026-08-19
// ("create one if you need").
//
// Deliberately does NOT create a new user: prod already carries a Test Field
// Crew account, and adding another would put a second fake worker in every
// crew list and payroll summary forever.
//
// Reads the PIN from the QA_PIN env var — never from argv, so it cannot land in
// shell history or an agent transcript (same rule as the Vercel token).
//   QA_PIN=1234 node scripts/set-test-crew-pin.mjs --apply
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const APPLY = process.argv.includes("--apply");
const TARGET_NAME = "Test Field Crew";

async function main() {
    const users = await prisma.user.findMany({
        where: { name: TARGET_NAME },
        select: { id: true, email: true, name: true, role: true, status: true, pinCode: true },
    });

    if (users.length !== 1) {
        console.error(`ABORT: expected exactly 1 user named "${TARGET_NAME}", found ${users.length}.`);
        for (const u of users) console.error(`  ${u.email} role=${u.role} status=${u.status}`);
        await prisma.$disconnect();
        process.exit(1);
    }

    const user = users[0];
    console.log(`TARGET: ${user.name} <${user.email}> role=${user.role} status=${user.status} pinSet=${!!user.pinCode}`);

    if (user.role !== "FIELD_CREW") {
        console.error(`ABORT: refusing to touch a non-FIELD_CREW account (role=${user.role}).`);
        await prisma.$disconnect();
        process.exit(1);
    }

    const pin = process.env.QA_PIN;
    if (!pin || !/^\d{4,8}$/.test(pin)) {
        console.error("ABORT: set QA_PIN to a 4-8 digit PIN in the environment (never on the command line).");
        await prisma.$disconnect();
        process.exit(1);
    }

    if (!APPLY) {
        console.log("\nDRY RUN — would set a bcrypt PIN on the above account. Pass --apply to write.");
        await prisma.$disconnect();
        return;
    }

    const hash = await bcrypt.hash(pin, 10);
    await prisma.user.update({ where: { id: user.id }, data: { pinCode: hash, status: "ACTIVATED" } });
    console.log(`\nPIN set for ${user.email}. Verify by logging in at app.goldentouchremodeling.com.`);
    await prisma.$disconnect();
}

main().catch(async (e) => { console.error("FAILED:", e); await prisma.$disconnect(); process.exit(1); });
