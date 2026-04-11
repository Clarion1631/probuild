"use client";
import { createContext, useContext, useEffect, useState, ReactNode } from "react";

interface PermissionsData {
    role: string;
    isAdmin: boolean;
    permissions: Record<string, boolean>;
    projectIds: string[];
    loaded: boolean;
}

const defaultPerms: PermissionsData = {
    role: "",
    isAdmin: false,
    permissions: {},
    projectIds: [],
    loaded: false,
};

const PermissionsContext = createContext<PermissionsData>(defaultPerms);

export function PermissionsProvider({ children }: { children: ReactNode }) {
    const [data, setData] = useState<PermissionsData>(defaultPerms);

    useEffect(() => {
        fetch("/api/me/permissions")
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (d) setData({ ...d, loaded: true });
                else setData({ ...defaultPerms, loaded: true }); // Not logged in
            })
            .catch((err) => {
                console.error("[Permissions] Failed to fetch permissions:", err);
                setData({ ...defaultPerms, loaded: true });
            });
    }, []);

    return (
        <PermissionsContext.Provider value={data}>
            {children}
        </PermissionsContext.Provider>
    );
}

export function usePermissions() {
    return useContext(PermissionsContext);
}

// Convenience: check a specific permission
export function useCan(key: string): boolean {
    const { permissions, isAdmin, loaded } = usePermissions();
    if (!loaded) return true; // Don't hide things while loading
    if (isAdmin) return true;
    return !!permissions[key];
}
