# `@bigbud/mobile-web`

Standalone mobile companion for `bigbud`.

## Pairing model

The hosted mobile app and the desktop backend are intentionally separate:

- mobile UI: Cloudflare Pages
- remote backend: desktop over Tailscale Serve

In desktop settings:

- `Mobile app URL` should point at the hosted Pages site
- `Backend URL` should point at the Tailscale HTTPS origin

That produces pairing links like:

```txt
https://mobile.bigbud.app/mobile/pair/<pairingId>?backend=https://your-device.tailnet.ts.net#secret=...
```
