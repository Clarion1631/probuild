export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";
import AppLayout from "@/components/AppLayout";
import { Toaster } from "sonner";
import { getCompanySettings } from "@/lib/actions";
import { getSessionOrDev } from "@/lib/auth";
import HelpChatWidget from "@/components/HelpChatWidget";

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
          <HelpChatWidget
            userId={session?.user?.id}
            userRole={session?.user?.role}
          />
        </Providers>
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
