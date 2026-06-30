import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";
import AppLayout from "@/components/AppLayout";
import { Toaster } from "sonner";
import { getCompanySettings } from "@/lib/actions";
import { getSessionOrDev } from "@/lib/auth";
import HelpChatWidgetWrapper from "@/components/HelpChatWidgetWrapper";
import VersionWatcher from "@/components/VersionWatcher";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Golden Touch Remodeling | Pro",
  description: "High-end remodeling project management",
  applicationName: "GTR Pro",
  appleWebApp: {
    capable: true,
    title: "GTR Pro",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#1e1e1e",
  width: "device-width",
  initialScale: 1,
  // viewportFit:cover is required so env(safe-area-inset-*) resolves to real
  // values on notched / home-indicator devices. We intentionally leave
  // maximumScale/userScalable at their defaults to preserve pinch-zoom (WCAG 1.4.4).
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let settings = null;
  let session: any = null;
  try {
    settings = await getCompanySettings();
    session = await getSessionOrDev();
  } catch {
    // During build-time static generation, DATABASE_URL may not exist — gracefully skip.
  }

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} bg-slate-50 text-slate-900 min-h-screen`}>
        <Providers>
          <AppLayout logoUrl={settings?.logoUrl ?? undefined}>
            {children}
          </AppLayout>
          <HelpChatWidgetWrapper
            userId={session?.user?.id}
            userRole={session?.user?.role}
          />
        </Providers>
        <Toaster position="bottom-right" richColors />
        <VersionWatcher />
      </body>
    </html>
  );
}
