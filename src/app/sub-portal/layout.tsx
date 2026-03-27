import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSubPortalSession } from "@/lib/sub-portal-auth";
import Link from "next/link";

async function LogoutButton() {
    return (
        <form action={async () => {
            "use server";
            const cookieStore = await cookies();
            cookieStore.delete("sub_portal_token");
            redirect("/sub-portal/login");
        }}>
            <button type="submit" className="text-sm text-hui-textMuted hover:text-red-600 font-medium transition">
                Logout
            </button>
        </form>
    );
}

export default async function SubPortalLayout({ children }: { children: React.ReactNode }) {
    // Pages under /sub-portal/login are public
    // Layout should still render for login page
    const sub = await getSubPortalSession();

    return (
        <div className="min-h-screen bg-hui-background flex flex-col">
            <header className="bg-white border-b border-hui-border px-6 md:px-8 py-4 flex items-center justify-between shadow-sm sticky top-0 z-50">
                <Link href="/sub-portal" className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-hui-primary rounded-lg flex items-center justify-center shadow-sm">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/>
                        </svg>
                    </div>
                    <span className="font-bold text-lg text-hui-textMain tracking-tight">ProBuild</span>
                </Link>

                {sub && (
                    <div className="flex items-center gap-4">
                        <div className="hidden sm:flex items-center gap-2.5">
                            <div className="w-8 h-8 bg-emerald-100 rounded-full flex items-center justify-center">
                                <span className="text-xs font-bold text-emerald-700">
                                    {(sub.contactName || sub.companyName).charAt(0).toUpperCase()}
                                </span>
                            </div>
                            <div className="text-right">
                                <p className="text-sm font-semibold text-hui-textMain leading-tight">{sub.contactName || sub.companyName}</p>
                                <p className="text-xs text-hui-textMuted leading-tight">{sub.trade || "Subcontractor"}</p>
                            </div>
                        </div>
                        <div className="w-px h-6 bg-hui-border hidden sm:block" />
                        <LogoutButton />
                    </div>
                )}
            </header>

            <main className="flex-1 w-full max-w-6xl mx-auto p-4 md:p-8">
                {children}
            </main>

            <footer className="border-t border-hui-border py-4 px-8 text-center">
                <p className="text-xs text-hui-textMuted">&copy; {new Date().getFullYear()} ProBuild. Subcontractor Portal.</p>
            </footer>
        </div>
    );
}
