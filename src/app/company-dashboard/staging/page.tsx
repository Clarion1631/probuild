export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

import { getSessionOrDev } from "@/lib/auth";
import { getUserWithPermissionsByEmail, hasPermission } from "@/lib/permissions";

import { StagingQueueClient } from "./StagingQueueClient";

export default async function StagingQueuePage() {
    const session = await getSessionOrDev();
    if (!session?.user?.email) return redirect("/login");

    const user = await getUserWithPermissionsByEmail(session.user.email);
    const effectiveUser = user ?? (process.env.NODE_ENV === "development"
        ? { role: "ADMIN", permissions: null }
        : null);
    const allowedRoles = ["ADMIN", "MANAGER", "FIELD_CREW"];
    if (
        !effectiveUser
        || !allowedRoles.includes(effectiveUser.role)
        || !hasPermission(effectiveUser, "schedules")
    ) {
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }

    return <StagingQueueClient />;
}
