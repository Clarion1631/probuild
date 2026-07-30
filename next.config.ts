import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Pin the workspace root: a stray package.json in an ancestor directory makes
  // Next infer the wrong root, which breaks CSS module resolution in `next dev`.
  outputFileTracingRoot: path.resolve(__dirname),
  // pdf-parse (and mammoth) pull in pdfjs, whose bundled build reaches for
  // browser globals like DOMMatrix that don't exist in the Node server runtime.
  // Bundling them produced "DOMMatrix is not defined" in production while a
  // direct node import of the same package worked, so keep them external and
  // let the server require() them at runtime. Verified against read_file.
  serverExternalPackages: ["pdf-parse", "mammoth", "@napi-rs/canvas"],
  // pdf-parse's pdfjs loads @napi-rs/canvas via a runtime createRequire, which
  // Next's file tracing can't see — the deployed lambda otherwise ships with
  // zero @napi-rs/canvas files, causing "Setting up fake worker failed" in
  // production. Force-include the package (+ its Linux prebuilt binary, the
  // only platform Vercel's lambda runs) for the MCP route specifically.
  outputFileTracingIncludes: {
    "/api/mcp/[transport]": [
      "./node_modules/@napi-rs/canvas/**",
      "./node_modules/@napi-rs/canvas-linux-x64-gnu/**",
    ],
  },
  turbopack: { root: path.resolve(__dirname) },
  experimental: {
    workerThreads: false,
    cpus: 1,
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.supabase.co",
      },
    ],
  },
};

export default nextConfig;
