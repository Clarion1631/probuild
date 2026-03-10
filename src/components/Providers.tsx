"use client";

import { SessionProvider } from "next-auth/react";
import { PermissionsProvider } from "@/components/PermissionsProvider";
import React from "react";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <PermissionsProvider>{children}</PermissionsProvider>
    </SessionProvider>
  );
}
