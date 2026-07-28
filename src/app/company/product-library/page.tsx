export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getProductLibrary, getProjects } from "@/lib/actions";
import ProductLibraryClient from "./ProductLibraryClient";

export default async function ProductLibraryPage() {
    const session = await getSessionOrDev();
    if (!session?.user) redirect("/login");
    const role = (session.user as any)?.role;
    if (role === "CLIENT") redirect("/portal");

    const [products, allProjectsRaw] = await Promise.all([
        getProductLibrary(),
        getProjects(),
    ]);

    const allProjects = allProjectsRaw
        .filter((p: any) => p.status !== "Archived")
        .map((p: any) => ({ id: p.id, name: p.name }));

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    return (
        <ProductLibraryClient
            initialProducts={JSON.parse(JSON.stringify(products))}
            allProjects={allProjects}
            appUrl={appUrl}
        />
    );
}
