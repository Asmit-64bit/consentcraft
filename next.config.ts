import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  turbopack: {
    resolveAlias: {
      "@base-org/account": "@base-org/account/browser",
    },
  },
  // This prototype uses plain CSS. No custom CSS loader is necessary.
  devIndicators: false,
};

export default nextConfig;
