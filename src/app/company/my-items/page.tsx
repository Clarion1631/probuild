export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import MyItemsClient from "./MyItemsClient";

export default async function MyItemsPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const [rawItems, costCodes] = await Promise.all([
        prisma.catalogItem.findMany({ orderBy: { name: "asc" }, include: { costCode: { select: { code: true, name: true } } } }),
        prisma.costCode.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    ]);

    return (
        <MyItemsClient
            items={items.map((item) => ({ ...item, unitCost: toNum(item.unitCost) }))}
            costCodes={costCodes}
        />
    );
}
