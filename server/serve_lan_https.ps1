param([string]$LanIp = "")
$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
if (-not $LanIp) {
  $Udp = [System.Net.Sockets.UdpClient]::new()
  try {
    $Udp.Connect("192.0.2.1", 9)
    $LanIp = ([System.Net.IPEndPoint]$Udp.Client.LocalEndPoint).Address.IPAddressToString
  } finally { $Udp.Dispose() }
}

$Address = [System.Net.IPAddress]::Parse($LanIp)
$Bytes = $Address.GetAddressBytes()
$Private = $Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and (
  $Bytes[0] -eq 10 -or ($Bytes[0] -eq 192 -and $Bytes[1] -eq 168) -or
  ($Bytes[0] -eq 172 -and $Bytes[1] -ge 16 -and $Bytes[1] -le 31)
)
if (-not $Private) { throw "请输入局域网私有 IPv4 地址，例如 192.168.1.20" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "请先安装 Node.js 18+" }
if (-not (Get-Command caddy -ErrorAction SilentlyContinue)) { throw "请先安装 Caddy 2" }
if (-not (Test-Path (Join-Path $ProjectDir "dist/index.html"))) { throw "找不到 dist/index.html，请从项目根目录运行脚本" }

$env:RTC_LAN_PORT = "8787"
$NodeScript = Join-Path $PSScriptRoot "lan_server.mjs"
$NodeServer = Start-Process -FilePath "node" -ArgumentList ('"' + $NodeScript + '"') -PassThru -NoNewWindow
Start-Sleep -Milliseconds 800
if ($NodeServer.HasExited) { throw "Node LAN server exited during startup. Verify Node.js 18+ and the project files." }
$Config = Join-Path $env:TEMP ("rtc-gpu-caddy-" + [guid]::NewGuid().ToString("N") + ".caddy")
@"
https://${LanIp}:8443 {
  bind 0.0.0.0
  tls internal
  reverse_proxy 127.0.0.1:8787
}
"@ | Set-Content -Path $Config -Encoding ascii

Write-Host "RTC 局域网服务地址: https://${LanIp}:8443"
Write-Host "手机和电脑需连接同一 Wi-Fi，并信任 Caddy 的 root.crt。"
Write-Host "用 'caddy environ' 查看证书数据目录；不要分享 root.key。"
Write-Host "按 Ctrl+C 停止服务。"
try { & caddy run --config $Config --adapter caddyfile }
finally {
  if (-not $NodeServer.HasExited) { Stop-Process -Id $NodeServer.Id -Force }
  Remove-Item $Config -Force -ErrorAction SilentlyContinue
}
