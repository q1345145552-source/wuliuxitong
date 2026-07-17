import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: "/auth/:path*", destination: "http://api:3001/auth/:path*" },
      { source: "/admin/:path*", destination: "http://api:3001/admin/:path*" },
      { source: "/staff/:path*", destination: "http://api:3001/staff/:path*" },
      { source: "/client/:path*", destination: "http://api:3001/client/:path*" },
      { source: "/images/:path*", destination: "http://api:3001/images/:path*" },
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
