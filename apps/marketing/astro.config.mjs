import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

const site = process.env.BIGBUD_MARKETING_SITE_URL ?? "https://bigbud.app";

export default defineConfig({
  site,
  vite: {
    plugins: [tailwindcss()],
  },
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
