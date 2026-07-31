import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveSessionClientId } from "@/lib/portal-auth";
import { getPublicCompanySettings } from "@/lib/actions";
import PortalUserMenu from "@/components/PortalUserMenu";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
    const session = await getServerSession(authOptions);
    const settings = await getPublicCompanySettings().catch(() => null);
    const companyName = settings?.companyName || "Golden Touch Remodeling";
    const isStaff = ["ADMIN", "MANAGER"].includes((session?.user as any)?.role);

    let displayName: string | null = null;
    let hasClientSession = false;
    if (!isStaff) {
        const clientId = await resolveSessionClientId();
        hasClientSession = Boolean(clientId);
        if (clientId) {
            const client = await prisma.client.findUnique({
                where: { id: clientId },
                select: { name: true },
            });
            displayName = client?.name ?? session?.user?.name ?? null;
        } else {
            displayName = session?.user?.name ?? null;
        }
    }

    // Show the user menu for staff (NextAuth), email-based clients (NextAuth), and token-based clients.
    const isAuthed = Boolean(session?.user) || hasClientSession;

    return (
        <div className="min-h-screen bg-hui-background flex flex-col">
            <header className="bg-white border-b border-hui-border px-4 md:px-8 py-4 flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-2.5 min-w-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={settings?.logoUrl || "/logo.png"}
                        alt={companyName}
                        className="h-9 w-9 rounded-lg object-contain shrink-0"
                    />
                    <span className="font-bold text-lg sm:text-xl text-hui-textMain tracking-tight truncate">{companyName}</span>
                </div>
                {isAuthed && <PortalUserMenu displayName={displayName} isStaff={isStaff} />}
            </header>
            <main className="flex-1 w-full max-w-5xl mx-auto p-4 md:p-8">
                {children}
            </main>
        </div>
    );
}
