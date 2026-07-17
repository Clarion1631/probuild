"use client";

// Room Studio - client boundary. Loads the WebGL canvas without SSR.

import dynamic from "next/dynamic";
import type { StudioProps } from "./Studio";

const Studio = dynamic(() => import("./Studio").then((m) => m.Studio), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-slate-100">
      <div className="flex flex-col items-center gap-3 text-slate-400">
        <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-slate-300 border-t-blue-500" />
        <span className="text-sm font-medium">Opening Room Studio...</span>
      </div>
    </div>
  ),
});

export default function StudioClient(props: StudioProps) {
  return <Studio {...props} />;
}
