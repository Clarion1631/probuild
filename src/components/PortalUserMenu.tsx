"use client";

import { signOut } from "next-auth/react";
import Avatar from "./Avatar";

interface Props {
    displayName: string | null;
    isStaff: boolean;
}

export default function PortalUserMenu({ displayName, isStaff }: Props) {
    const label = isStaff ? "Staff Preview" : (displayName || "Account");
    const firstName = isStaff ? "Staff" : (displayName?.split(" ")[0] || "");
    const avatarName = isStaff ? "Staff" : (displayName || "?");

    const handleSignOut = async () => {
        // Clear the magic-link cookie for portal-token clients before NextAuth signOut.
        try {
            await fetch("/api/portal/signout", { method: "POST" });
        } catch {}
        await signOut({ callbackUrl: "/login" });
    };

    return (
        <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
                <Avatar name={avatarName} color={isStaff ? "orange" : "blue"} size="sm" />
                <span className="hidden sm:inline text-sm font-medium text-hui-textMain max-w-[140px] truncate" title={label}>
                    {firstName || label}
                </span>
            </div>
            <button
                onClick={handleSignOut}
                className="text-sm font-medium text-red-600 hover:text-red-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 rounded px-1"
            >
                Sign out
            </button>
        </div>
    );
}
