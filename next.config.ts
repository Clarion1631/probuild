import type { NextConfig } from "next";

if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim()) {
  throw new Error("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is required but not set");
}

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "prisma"],
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
