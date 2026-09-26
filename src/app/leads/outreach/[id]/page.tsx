import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isApprover, DISPATCH_FROM_ADDRESS } from "@/lib/speed-to-lead/constants";
import { computeApprovalHash } from "@/lib/speed-to-lead/approval";
import { mintOutreachCsrfToken } from "@/lib/speed-to-lead/csrf";
import OutreachApprovalForm from "./OutreachApprovalForm";

/**
 * Outreach detail / approval page (spec Approval "How": "A GET only
 * displays"). Everything mutating happens through the Server Actions in
 * OutreachApprovalForm.
 */
export default async function OutreachDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    const sessionEmail = session?.user?.email ?? null;
    const canApprove = isApprover(sessionEmail);

    const message = await prisma.outreachMessage.findUnique({
        where: { id },
        include: {
            lead: { select: { id: true, name: true, client: { select: { name: true, email: true } } } },
            versions: { orderBy: { generation: "desc" }, take: 1 },
            attempts: { orderBy: { createdAt: "desc" }, take: 5 },
        },
    });

    if (!message) {
        return <div className="p-8">Outreach message not found.</div>;
    }

    const version = message.versions[0];
    const threading = (version?.threading ?? {}) as { inReplyTo: string | null; references: string | null; threadId: string | null };
    const approvalHash = version
        ? computeApprovalHash({
            leadId: message.leadId, messageId: message.id, generation: message.generation,
            from: DISPATCH_FROM_ADDRESS, to: version.to, subject: version.subject, body: version.body, footer: version.footer,
            inReplyTo: threading.inReplyTo, references: threading.references, threadId: threading.threadId,
        })
        : "";

    const approveToken = sessionEmail && version ? mintOutreachCsrfToken(sessionEmail, message.id, version.id) : "";
    const draftToken = sessionEmail ? mintOutreachCsrfToken(sessionEmail, message.id, "draft") : "";
    const sendAgainToken = sessionEmail ? mintOutreachCsrfToken(sessionEmail, message.id, "send-again") : "";

    return (
        <div className="p-8 max-w-2xl mx-auto space-y-4">
            <div className="hui-card p-6">
                <h1 className="text-lg font-semibold mb-1">
                    {message.kind} — {message.lead.name}
                </h1>
                <p className="text-sm text-gray-500 mb-4">Status: {message.status} · Generation {message.generation}</p>

                {version ? (
                    <div className="space-y-2 text-sm">
                        <div><span className="font-medium">To:</span> {version.to}</div>
                        <div><span className="font-medium">Subject:</span> {version.subject}</div>
                        <div className="whitespace-pre-wrap border rounded p-3 bg-gray-50">{version.body}</div>
                        <div className="whitespace-pre-wrap text-xs text-gray-500 border-t pt-2">{version.footer}</div>
                    </div>
                ) : (
                    <p className="text-sm text-gray-500">No version yet.</p>
                )}
            </div>

            {message.attempts.length > 0 && (
                <div className="hui-card p-4 text-sm">
                    <div className="font-medium mb-2">Attempts</div>
                    {message.attempts.map(a => (
                        <div key={a.id}>{a.rfcMessageId} — {a.outcome ?? "pending"}</div>
                    ))}
                </div>
            )}

            {canApprove && version && (
                <OutreachApprovalForm
                    messageId={message.id}
                    versionId={version.id}
                    leadId={message.leadId}
                    status={message.status}
                    approvalHash={approvalHash}
                    approveToken={approveToken}
                    draftToken={draftToken}
                    sendAgainToken={sendAgainToken}
                    initialTo={version.to}
                    initialSubject={version.subject}
                    initialBody={version.body}
                    initialFooter={version.footer}
                />
            )}
            {!canApprove && (
                <p className="text-sm text-gray-500">Only the approver can act on this message.</p>
            )}
        </div>
    );
}
