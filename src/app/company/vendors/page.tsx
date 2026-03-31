import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import VendorsClient from "./VendorsClient";

export default async function VendorsPage() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) redirect("/login");

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        include: { permissions: true }
    });
    if (!user) redirect("/login");

    if (user.role !== "ADMIN" && user.role !== "MANAGER") {
        redirect("/company");
    }

    const vendors = await prisma.vendor.findMany({
        orderBy: { name: "asc" }
    });

    return <VendorsClient initialVendors={vendors} />;
}
