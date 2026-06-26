## Cloudflare Pages

Cloudflare Pages is a reasonable fit here:

- static Vite output
- easy custom domain support
- cheap global hosting
- good path toward a later PWA

For this monorepo, configure Pages against the repository root rather than `apps/mobile-web` directly so workspace dependencies resolve correctly.

Recommended Pages settings:

- Root directory: repository root
- Build command: `bun run build:mobile-web`
- Build output directory: `apps/mobile-web/dist`

Optional follow-up settings:

- Custom domain: `mobile.bigbud.app`
- Build watch path: `apps/mobile-web/*`, `apps/web/*`, `packages/contracts/*`, `packages/shared/*`
