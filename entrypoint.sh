#!/bin/sh
# Build /app/config.json from environment and run Xray.
# Required: UUID (VLESS client id), WS_PATH (WebSocket path, e.g. /your-random-path).
# PORT is provided by Railway; defaults to 8080 for local testing.
set -eu
: "${UUID:?UUID env var is required}"
: "${WS_PATH:?WS_PATH env var is required}"
: "${PORT:=8080}"
: "${CONFIG_PATH:=/app/config.json}"
: "${XRAY_BIN:=/usr/local/bin/xray}"
cat > "${CONFIG_PATH}" <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "port": ${PORT},
      "listen": "0.0.0.0",
      "protocol": "vless",
      "settings": {
        "clients": [ { "id": "${UUID}", "flow": "" } ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "ws",
        "wsSettings": { "path": "${WS_PATH}" }
      }
    }
  ],
  "outbounds": [ { "protocol": "freedom", "tag": "direct" } ]
}
EOF
exec "${XRAY_BIN}" run -config "${CONFIG_PATH}"
