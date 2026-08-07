// SPDX-License-Identifier: AGPL-3.0-or-later

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiProxyTarget = process.env.OSS_API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": apiProxyTarget,
      "/health": apiProxyTarget,
    },
  },
});
