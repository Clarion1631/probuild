export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getCompanySettings } from "@/lib/actions";
import CalendarSettingsClient from "./CalendarSettingsClient";

export default async function CalendarSettingsPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const settings = await getCompanySettings();
    return <CalendarSettingsClient settings={settings} />;
}
