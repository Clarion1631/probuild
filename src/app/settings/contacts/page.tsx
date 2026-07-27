export const dynamic = "force-dynamic";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getClients } from "@/lib/actions";
import { resolveDocUrl } from "@/lib/secure-storage";
import ContactsClient from "./ContactsClient";

export default async function ContactsPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const clientsRaw = await getClients();
    const clients = await Promise.all(clientsRaw.map(async (c: any) => ({
        ...c,
        taxExemptCertUrl: await resolveDocUrl(c.taxExemptCertUrl),
    })));
    return <ContactsClient clients={clients} />;
}
