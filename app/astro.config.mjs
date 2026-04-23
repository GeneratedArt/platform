import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";
import cloudflare from "@astrojs/cloudflare";
import { fileURLToPath } from "node:url";

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  site: "https://app.generatedart.com",
  output: "server",
  adapter: cloudflare({ mode: "directory" }),
  integrations: [preact()],
  server: { host: "0.0.0.0", port: 4321 },
  vite: {
    resolve: {
      alias: {
        "~": r("./src"),
      },
    },
    server: {
      host: true,
      hmr: { clientPort: 443 },
    },
  },
});
