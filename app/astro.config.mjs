import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: "https://app.generatedart.com",
  output: "server",
  adapter: cloudflare({ mode: "directory" }),
  integrations: [preact()],
  server: { host: "0.0.0.0", port: 4321 },
  vite: {
    server: {
      // Replit preview is proxied; allow all hosts for dev.
      host: true,
      hmr: { clientPort: 443 },
    },
  },
});
