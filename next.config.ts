import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  experimental: {
    // proxy.ts 経由のリクエストは Next が body をメモリにバッファするため既定 10MB 上限。
    // VRM upload は route 側で 60MB まで許可 (= src/app/api/vrm/models/route.ts の
    // MAX_VRM_BYTES)。10MB を超える VRM は proxy 層で本文が切られ formData parse が
    // 落ちて 500 になるので、VRM 60MB + サムネ 2MB + multipart overhead を見込んで上げる。
    proxyClientMaxBodySize: "70mb",
  },
  webpack: (config) => {
    config.module.rules.push({
      test: /\.(vrm|glb|gltf)$/,
      type: "asset/resource",
    });
    return config;
  },
};

export default nextConfig;
