import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack externalization dla @sparticuz/chromium
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  // Fallback webpack dla zgodności
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(config.externals || []),
        '@sparticuz/chromium',
        'playwright',
        'playwright-core',
      ];
    }
    return config;
  },
};

export default nextConfig;
