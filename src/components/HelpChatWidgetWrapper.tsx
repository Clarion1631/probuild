"use client";

import dynamic from "next/dynamic";

const HelpChatWidget = dynamic(() => import("./HelpChatWidget"), {
  ssr: false,
  loading: () => null,
});

export default function HelpChatWidgetWrapper({ userId, userRole }: { userId?: string; userRole?: string }) {
  return <HelpChatWidget userId={userId} userRole={userRole} />;
}
