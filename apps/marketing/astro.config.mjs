import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

const site = process.env.BIGBUD_MARKETING_SITE_URL ?? "https://bigbud.app";

export default defineConfig({
  site,
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
