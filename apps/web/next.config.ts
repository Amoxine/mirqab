import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { createMDX } from 'fumadocs-mdx/next';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
// Pinned to fumadocs-core/ui 15.8 and fumadocs-mdx 13 on purpose: 16.x needs Next 16. Move to 16.x with the Next upgrade.
const withMDX = createMDX();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@open-gateway/ui', '@open-gateway/types'],
  output: 'standalone',
  poweredByHeader: false,
  compress: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.amazonaws.com',
      },
      {
        protocol: 'https',
        hostname: '**.cloudfront.net',
      },
    ],
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 31536000,
  },
  logging: {
    fetches: {
      fullUrl: process.env.NODE_ENV === 'development',
    },
  },
  typedRoutes: true,
  // ponytail: no `serverActions` block — it was a top-level key Next 15 does not recognise ("Invalid
  // next.config.ts options detected" on every build), and this app has no server actions: the
  // dashboard talks to the NestJS API from the client.
};

export default withMDX(withNextIntl(nextConfig));
