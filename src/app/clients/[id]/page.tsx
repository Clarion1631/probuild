import { getClient } from "@/lib/actions";
import { notFound } from "next/navigation";
import ClientEditableCard from "./ClientEditableCard";
import ClientDetailTabs from "./ClientDetailTabs";

export const dynamic = "force-dynamic";

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const client = await getClient(resolvedParams.id);

    if (!client) {
        notFound();
    }

    // Sort related items if necessary or pass them all directly
    return (
        <div className="p-6 max-w-7xl mx-auto">
            <div className="flex items-center mb-6">
                <h1 className="text-2xl font-bold text-hui-textMain">{client.name}</h1>
                <span className="ml-3 px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-xs font-semibold uppercase tracking-wider">
                    Client Reference
                </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Left Pane: Contact Info */}
                <div className="lg:col-span-1 border-r border-transparent">
                    <ClientEditableCard client={client} />
                </div>

                {/* Right Pane: Activity & Related Entities */}
                <div className="lg:col-span-2">
                    <div className="bg-white rounded-lg border border-hui-border shadow-sm min-h-[600px]">
                        <ClientDetailTabs client={client} />
                    </div>
                </div>
            </div>
        </div>
    );
}

