import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  // This prototype uses plain CSS. No custom CSS loader is necessary.
  devIndicators: false,
};

export default nextConfig;
