# RTC GPU Studio

Browser demo for camera capture, WebRTC audio/video, MediaPipe face stickers, and side-by-side WebGPU/WebGL rendering.

## Production architecture

- GitHub Pages hosts the HTTPS frontend from this repository; the root page redirects to `dist/`.
- A Cloudflare Worker with a Durable Object exchanges WebRTC offers, answers, and ICE candidates. It carries signaling only; media stays peer-to-peer when the network permits.
- A TURN service relays media when direct connectivity is blocked. The Worker can issue short-lived TURN credentials using coturn's shared-secret REST authentication.
- Share links include an automatically generated, unguessable session identifier. Users do not type or manage room codes.

GitHub Pages only serves static files and cannot run the Node signaling server. The LAN server remains available as an optional local mode.

## Deploy

1. The user site repository must be named `<username>.github.io`; this project is configured for `wshixiaolaji.github.io`. GitHub Pages publishes from the `main` branch root, and the root page redirects to the app in `dist/`.
2. Create a Cloudflare Worker with Durable Objects enabled. Add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; then run the `Deploy signaling Worker` workflow manually to publish `cloudflare/worker.js`.
3. Set `signalBase` in `dist/config.js` to the deployed Worker origin, for example `https://rtc-gpu-studio-signal.<your-subdomain>.workers.dev`. `ALLOWED_ORIGIN` in `cloudflare/wrangler.toml` is set to `https://wshixiaolaji.github.io`.
4. Provision a TURN server (for example, coturn on a VPS). Configure coturn with `use-auth-secret` and a private `static-auth-secret`. Set `TURN_URLS` in `cloudflare/wrangler.toml` to the server's UDP/TCP/TLS TURN URLs, then add the same secret to the Worker with `npx wrangler secret put TURN_SHARED_SECRET --config cloudflare/wrangler.toml`.
5. Push the configuration to `main`; GitHub Pages republishes automatically. Open the Pages URL on both devices; the sender starts sharing and copies the generated receiver link.

The frontend can be published before the signaling service is configured, but sending and receiving will not work until `signalBase` points to the deployed Worker. The generated receiver link contains a random session identifier; anyone holding that link can join the live stream. Do not commit the TURN shared secret or Cloudflare API token. Without TURN configured, the demo falls back to STUN and can still fail on Wi-Fi networks that block peer-to-peer traffic.

## Optional LAN mode

Install Node.js 18+ and Caddy 2, then run `server/serve_lan_https.sh` (Windows: `server/serve_lan_https.ps1`). The server serves `dist/` and provides the same session-signaling API on the LAN. Use the generated HTTPS private-IP link; both devices must trust the local certificate and be allowed to communicate over the local network.
