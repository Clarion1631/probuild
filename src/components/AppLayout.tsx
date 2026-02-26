"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import Header from "./Header";

export default function AppLayout({ children, logoUrl }: { children: React.ReactNode, logoUrl?: string }) {
    const pathname = usePathname();
    const isPublicRoute = pathname?.startsWith('/portal') || pathname === '/login';

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
