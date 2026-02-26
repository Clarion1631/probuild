"use client";

import { usePathname, useRouter } from "next/navigation";
import Sidebar from "./Sidebar";
import Header from "./Header";
import { useSession } from "next-auth/react";
import { useEffect } from "react";

export default function AppLayout({ children, logoUrl }: { children: React.ReactNode, logoUrl?: string }) {
    const pathname = usePathname();
    const router = useRouter();
    const { data: session, status } = useSession();
    const role = (session?.user as any)?.role;

    useEffect(() => {
        if (status === 'authenticated') {
            const isPublicRoute = pathname?.startsWith('/portal') || pathname === '/login';

            if (role === 'CLIENT' && !isPublicRoute) {
                router.replace('/portal');
            }
        }
    }, [status, role, pathname, router]);

    const isPublicRoute = pathname?.startsWith('/portal') || pathname === '/login';

    if (role === 'CLIENT' && !isPublicRoute) {
        return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-slate-500">Redirecting to Portal...</div>;
    }

    if (isPublicRoute) {
        return <>{children}</>;
    }

    return (
        <div className="flex min-h-screen h-full bg-slate-50">
            <Sidebar />
            <div className="flex-1 flex flex-col overflow-hidden">
                <Header />
                <main className="flex-1 p-6 overflow-auto">
                    {children}
                </main>
            </div>
        </div>
    );
}
