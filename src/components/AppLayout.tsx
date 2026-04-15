"use client";

import { usePathname, useRouter } from "next/navigation";
import Sidebar from "./Sidebar";
import Header from "./Header";
import { useSession, signOut } from "next-auth/react";
import { useEffect } from "react";

export default function AppLayout({ children, logoUrl }: { children: React.ReactNode, logoUrl?: string }) {
    const pathname = usePathname();
    const router = useRouter();
    const { data: sessionData, status: sessionStatus } = useSession();
    
    // DEVELOPMENT ONLY: Authentication bypass for local testing
    const isDevMock = process.env.NODE_ENV === 'development' && !sessionData;
    
    const session = isDevMock ? {
        user: {
            email: 'gtrsupport@goldentouchremodeling.com',
            name: 'Test User',
            image: '', // Optional: provide a mock image URL
            role: 'ADMIN', // Assign ADMIN role for full access
        },
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
    } : sessionData;
    
    const status = isDevMock ? 'authenticated' : sessionStatus;
    const role = (session?.user as any)?.role;

    useEffect(() => {
        if (status === 'authenticated') {
            const isPublicRoute = pathname?.startsWith('/portal') || pathname?.startsWith('/sub-portal') || pathname === '/login';

            // If an authenticated user suddenly has no role, they were likely deleted.
            // Force sign out to clear the stale session so they can try again.
            if (!role && session?.user && !isPublicRoute) {
                signOut({ callbackUrl: '/login?error=AccessDenied' });
                return;
            }

            if (role === 'CLIENT' && !isPublicRoute) {
                router.replace('/portal');
            }
        }
        if (status === 'unauthenticated' && process.env.NODE_ENV !== 'development') { // Bypass only if NOT in development
            const isPublicRoute = pathname?.startsWith('/portal') || pathname?.startsWith('/sub-portal') || pathname === '/login';
            if (!isPublicRoute) {
                router.replace('/login');
            }
        }
    }, [status, role, pathname, router, session]);

    const isPublicRoute = pathname?.startsWith('/portal') || pathname?.startsWith('/sub-portal') || pathname === '/login';

    if (status === 'authenticated' && !role && !isPublicRoute) {
        return <div className="min-h-screen bg-hui-background flex items-center justify-center text-slate-500">Signing out...</div>;
    }

    if (role === 'CLIENT' && !isPublicRoute) {
        return <div className="min-h-screen bg-hui-background flex items-center justify-center text-slate-500">Redirecting to Portal...</div>;
    }

    if (isPublicRoute) {
        return <>{children}</>;
    }

    return (
        <div className="flex h-screen bg-hui-background overflow-hidden">
            <Sidebar />
            <div className="flex-1 flex flex-col overflow-hidden">
                <Header />
                <main className="flex-1 p-6 overflow-y-auto overflow-x-hidden">
                    {children}
                </main>
            </div>
        </div>
    );
}
