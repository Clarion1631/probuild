export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import TimeBillingClient from "./TimeBillingClient";

export default async function TimeBillingPage({
    searchParams,
}: {
    searchParams: Promise<{ groupBy?: string }>;
}) {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const { groupBy = "employee" } = await searchParams;

    const rawEntries = await prisma.timeEntry.findMany({
        include: {
            user: { select: { id: true, name: true } },
            project: { select: { id: true, name: true } },
            costCode: { select: { code: true, name: true } },
        },
        orderBy: { startTime: "desc" },
    });

    const entries = rawEntries.map(e => ({ ...e, laborCost: e.laborCost !== null ? Number(e.laborCost) : null }));

    return <TimeBillingClient entries={entries} groupBy={groupBy} />;
}
