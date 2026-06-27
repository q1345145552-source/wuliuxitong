import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  poweredByHeader: false,
  async rewrites() {
    const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "http://api:3001";
    return [
      { source: "/auth/:path*", destination: `${apiBase}/auth/:path*` },
      { source: "/admin/:path*", destination: `${apiBase}/admin/:path*` },
      { source: "/staff/:path*", destination: `${apiBase}/staff/:path*` },
      { source: "/client/:path*", destination: `${apiBase}/client/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https:; font-src 'self' data:;",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
