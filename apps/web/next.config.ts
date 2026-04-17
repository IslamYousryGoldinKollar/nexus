import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Allow importing from workspace packages (TypeScript source) without
  // requiring them to be built first. Next.js transpiles them at build time.
  transpilePackages: ['@nexus/shared', '@nexus/db', '@nexus/inngest-fns'],
  experimental: {
    // Server Actions body size — webhook payloads can include base64 audio.
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  // Standalone output for cheaper Vercel cold starts + Docker portability.
  output: 'standalone',
  logging: {
    fetches: {
      fullUrl: false,
    },
  },
};

export default config;
