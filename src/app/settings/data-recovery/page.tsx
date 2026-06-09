export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { listTrash, listAuditLog } from "@/lib/soft-delete";
import DataRecoveryClient from "./DataRecoveryClient";

export default async function DataRecoveryPage() {
    const session = await getSessionOrDev();
    if (!session?.user?.email) return redirect("/login");

    let role = (session.user as any).role as string | undefined;
    if (!role) {
        const u = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { role: true },
        });
        role = u?.role;
    }
    // ADMIN-only — the trash exposes deleted customer data across all clients.
    if (role !== "ADMIN") return redirect("/settings");

    const [trash, audit] = await Promise.all([listTrash(), listAuditLog(200)]);
    return <DataRecoveryClient initialTrash={trash} initialAudit={audit} />;
}
