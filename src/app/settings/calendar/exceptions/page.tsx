export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getWorkdayExceptions } from "@/lib/actions";
import ExceptionsClient from "./ExceptionsClient";

export default async function WorkdayExceptionsPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const exceptions = await getWorkdayExceptions();
    return <ExceptionsClient initialExceptions={exceptions} />;
}
