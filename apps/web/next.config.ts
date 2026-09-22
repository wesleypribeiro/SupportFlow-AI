import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: '/api/chat', destination: 'http://127.0.0.1:3001/api/chat' }];
  },
};

export default nextConfig;
