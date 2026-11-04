#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAN_IP="${1:-}"

if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(python3 - <<'PY'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.connect(('192.0.2.1', 9))
    print(s.getsockname()[0])
finally:
    s.close()
PY
)"
fi

python3 - "$LAN_IP" <<'PY'
import ipaddress, sys
try:
    address = ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit("无法自动判断局域网 IP，请手动传入，例如：./server/serve_lan_https.sh 192.168.1.20")
if address.version != 4 or not address.is_private:
    raise SystemExit("请输入私有网段 IPv4 地址，例如 192.168.1.20")
PY

command -v node >/dev/null || { echo "未找到 Node.js 18+。" >&2; exit 1; }
command -v caddy >/dev/null || { echo "未找到 Caddy。请先安装 Caddy。" >&2; exit 1; }
[[ -f "$PROJECT_DIR/dist/index.html" ]] || { echo "找不到项目的 dist/index.html。" >&2; exit 1; }

node "$PROJECT_DIR/server/lan_server.mjs" &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
sleep 1
kill -0 "$SERVER_PID" 2>/dev/null || { echo "局域网信令服务启动失败。" >&2; exit 1; }

CONFIG="$(mktemp)"
trap 'rm -f "$CONFIG"; cleanup' EXIT INT TERM
cat > "$CONFIG" <<CADDY
https://${LAN_IP}:8443 {
  bind 0.0.0.0
  tls internal
  reverse_proxy 127.0.0.1:8787
}
CADDY

echo "RTC 局域网服务已启动: https://${LAN_IP}:8443"
echo "请让手机和电脑连接同一 Wi-Fi，并在两台设备上信任 Caddy 的 root.crt。"
echo "证书通常位于: ~/.local/share/caddy/pki/authorities/local/root.crt"
echo "如无法自动获取 IP，可用 ./server/serve_lan_https.sh <局域网IPv4> 重启。"
echo "按 Ctrl+C 停止服务。"
caddy run --config "$CONFIG" --adapter caddyfile
