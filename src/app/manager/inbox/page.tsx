export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";

export default async function UnmatchedInboxPage() {
    const user = await getCurrentUserWithPermissions();
    if (!user) redirect("/login");
    if (!hasPermission(user, "clientCommunication")) redirect("/");

    // Unmatched inbound SMS: phone numbers that didn't resolve to any Client.
    // senderName holds the E.164 phone (or raw Twilio From) for these rows
    // because client is null in the inbound webhook when no match is found.
    const messages = await prisma.clientMessage.findMany({
        where: { leadId: null, projectId: null, direction: "INBOUND" },
        orderBy: { createdAt: "desc" },
        take: 100,
    });

    return (
        <div className="p-6 max-w-4xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl font-bold text-slate-900">Unmatched Inbox</h1>
                <p className="text-sm text-slate-500 mt-1">
                    Inbound SMS from phone numbers that didn&apos;t match any client record.
                </p>
            </div>

            {messages.length === 0 ? (
                <div className="hui-card flex flex-col items-center justify-center py-16 text-center">
                    <svg className="w-10 h-10 text-slate-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                    </svg>
                    <p className="text-slate-500 font-medium">No unmatched messages</p>
                    <p className="text-slate-400 text-sm mt-1">Inbound SMS from unknown numbers will appear here.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {messages.map((msg) => {
                        const phone = encodeURIComponent(msg.senderName);
                        const receivedAt = new Date(msg.createdAt).toLocaleString();
                        const snippet = msg.body.length > 120 ? msg.body.slice(0, 120) + "…" : msg.body;

                        return (
                            <div key={msg.id} className="hui-card flex items-start justify-between gap-4">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="font-semibold text-slate-800 text-sm">{msg.senderName}</span>
                                        <span className="text-xs text-slate-400">{receivedAt}</span>
                                    </div>
                                    <p className="text-sm text-slate-600 break-words">{snippet}</p>
                                </div>
                                <Link
                                    href={`/leads/new?phone=${phone}`}
                                    className="hui-btn shrink-0 text-sm"
                                >
                                    Create Lead
                                </Link>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
