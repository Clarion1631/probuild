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
  serverExternalPackages: ["pdf-parse", "mammoth"],
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
