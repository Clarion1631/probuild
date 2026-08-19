// READ-ONLY dev check: exercises the real HTTP route for the phase item step
// against the local dev server, using a genuine mobile JWT. Proves the route
// (auth + project scoping + section filtering), not just the library.
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });

async function main() {
    const { PrismaClient } = await import("@prisma/client");
    const { signMobileToken } = await import("../src/lib/mobile-auth.js");
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    const BASE = "http://localhost:3000";

    const user = await prisma.user.findFirst({ where: { email: "testcrew@goldentouchremodeling.com" } });
    const token = await signMobileToken(user, "pin");
    const auth = { Authorization: `Bearer ${token}` };

    const hoppe = await prisma.project.findFirst({ where: { name: "Hoppe Bathroom Remodel" }, select: { id: true } });
    const berg = await prisma.project.findFirst({ where: { name: "Berg ADU" }, select: { id: true } });
    const fixture = await prisma.costCode.findFirst({ where: { code: "19-FIXTURE" }, select: { id: true } });
    const demo = await prisma.costCode.findFirst({ where: { code: "01-DEMO" }, select: { id: true } });
    const safety = await prisma.costCode.findFirst({ where: { code: "32-SAFETY" }, select: { id: true } });

    async function hit(label, projectId, costCodeId) {
        const res = await fetch(`${BASE}/api/projects/${projectId}/cost-codes/${costCodeId}/items`, { headers: auth });
        const body = await res.json();
        console.log(`\n${label}`);
        console.log(`  HTTP ${res.status}  action=${body.action ?? body.code ?? body.error}`);
        if (Array.isArray(body.items)) {
            console.log(`  ${body.items.length} item(s), autoSelect=${body.autoSelectItemId ?? "null"}`);
            for (const i of body.items) console.log(`     - ${i.name}  $${i.total}`);
        }
        return body;
    }

    await hit("CHOOSE case — Hoppe / 19-FIXTURE (5 items)", hoppe.id, fixture.id);
    await hit("AUTO case — Berg ADU / 01-DEMO (1 item)", berg.id, demo.id);
    await hit("NONE case — Berg ADU / 32-SAFETY (no estimate line)", berg.id, safety.id);
    // A cost code that is NOT one of this project's phases must be refused, not
    // answered with another job's items.
    await hit("CROSS-PROJECT — Berg ADU / 19-FIXTURE (Hoppe's phase)", berg.id, fixture.id);

    console.log("\nunauth check:");
    const noAuth = await fetch(`${BASE}/api/projects/${hoppe.id}/cost-codes/${fixture.id}/items`);
    console.log(`  HTTP ${noAuth.status} (expect 401)`);

    await prisma.$disconnect();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
