// READ-ONLY dev check for the stale-item rejection path.
//
// Proves the server returns the CODED rejections the crew app relies on to
// recover. Without a code the client cannot tell a stale item from a real
// validation error, and the crew ends up in the retry dead-end this fixes.
//
// Read-only: it only POSTs deliberately-invalid clock-ins, which are rejected
// before anything is written. Verified by re-counting time entries after.
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
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const before = await prisma.timeEntry.count();

    const hoppe = await prisma.project.findFirst({ where: { name: "Hoppe Bathroom Remodel" }, select: { id: true } });
    const elec = await prisma.costCode.findFirst({ where: { code: "04-ELEC" }, select: { id: true } });
    const demo = await prisma.costCode.findFirst({ where: { code: "01-DEMO" }, select: { id: true } });

    // A real, eligible item under 04-ELEC on this project.
    const { prismaPhaseItemsDataSource } = await import("../src/lib/phase-items-db.js");
    const { resolvePhaseItems } = await import("../src/lib/phase-items.js");
    const elecItems = await resolvePhaseItems(prismaPhaseItemsDataSource, hoppe.id, elec.id);
    const elecItem = elecItems[0];

    async function post(label, body, expectCode) {
        const res = await fetch(`${BASE}/api/time-entries`, {
            method: "POST", headers, body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        const ok = res.status === 400 && json.code === expectCode;
        console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
        console.log(`        HTTP ${res.status}  code=${json.code ?? "(none)"}  ${String(json.error ?? "").slice(0, 70)}`);
        return ok;
    }

    console.log("Item/phase mismatch and stale-item rejections must be CODED\n");
    const results = [];
    // Item under 04-ELEC, but the crew's tapped phase says 01-DEMO.
    results.push(await post(
        "mismatch: item from 04-ELEC sent with phase 01-DEMO",
        { projectId: hoppe.id, costCodeId: demo.id, estimateItemId: elecItem.estimateItemId },
        "ITEM_PHASE_MISMATCH"
    ));
    // An item id that is not on any eligible estimate of this project.
    results.push(await post(
        "stale: item id that does not belong to this project",
        { projectId: hoppe.id, costCodeId: elec.id, estimateItemId: "definitely-not-a-real-item-id" },
        "ITEM_NOT_ON_PROJECT"
    ));

    const after = await prisma.timeEntry.count();
    console.log(`\ntime entries before=${before} after=${after}  ${before === after ? "(nothing written — read-only)" : "!!! WROTE DATA !!!"}`);
    console.log(results.every(Boolean) ? "\nALL CODED REJECTIONS OK" : "\nSOME REJECTIONS UNCODED — the crew app cannot recover");
    await prisma.$disconnect();
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
