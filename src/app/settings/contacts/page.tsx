export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getClients } from "@/lib/actions";
import ContactsClient from "./ContactsClient";

export default async function ContactsPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const clients = await getClients();
    return <ContactsClient clients={clients} />;
}
