import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  webpack: (config) => {
    config.module.rules.push({
      test: /\.(vrm|glb|gltf)$/,
      type: "asset/resource",
    });
    return config;
  },
};

export default nextConfig;
