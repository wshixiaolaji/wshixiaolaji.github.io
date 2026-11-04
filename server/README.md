# Local LAN mode

The Node.js server serves the demo and exchanges WebRTC signaling messages on the same host. Media remains peer-to-peer. The sender creates a temporary session and shares a link containing its generated session identifier; receivers open that link. No one has to enter a room code.

## Start

Install Node.js 18+ and Caddy 2, then run from the project root:

```bash
./server/serve_lan_https.sh
```

On Windows PowerShell:

```powershell
.\server\serve_lan_https.ps1
```

The script prints an HTTPS private-IP address. Both devices must be able to reach the host and trust Caddy's local root certificate. If the Wi-Fi enables client isolation, use another network or the public deployment with TURN.

The local server supports one sender and up to 100 receivers per share session. Sessions expire after one hour. It keeps signaling data in memory and does not store the media stream.
