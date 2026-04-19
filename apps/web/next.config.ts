import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Allow importing from workspace packages (TypeScript source) without
  // requiring them to be built first. Next.js transpiles them at build time.
  transpilePackages: ['@nexus/shared', '@nexus/db', '@nexus/inngest-fns', '@nexus/services'],
  experimental: {
    // Server Actions body size — webhook payloads can include base64 audio.
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  // Vercel packages the build itself; we only enable `output: standalone`
  // when self-hosting via Docker (see `docs/self-hosting.md`). Enabling it
  // on Vercel triggers a Next 15.5 edge case where /_error prerendering
  // fails with "<Html> should not be imported outside of pages/_document".
  // output: 'standalone',
  logging: {
    fetches: {
      fullUrl: false,
    },
  },
  // We author TypeScript ESM with explicit `.js` extensions on relative
  // imports (required by NodeNext). Webpack defaults to literal resolution,
  // so we map `.js` → `.ts`/`.tsx`/`.js`/`.jsx` here. This lets `next build`
  // resolve `import { x } from './foo.js'` to `./foo.ts` in both the app
  // and transpiled workspace packages.
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    return config;
  },
};

export default config;
