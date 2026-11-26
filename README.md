# xray-railway (VLESS + WebSocket + TLS)

Personal Xray proxy deployed on Railway.

How it works:
- Railway terminates TLS at the edge (automatic Let's Encrypt certificate on the
  generated `*.up.railway.app` domain) and forwards plain HTTP to this service.
- Xray listens on Railway's `$PORT` for plain WebSocket and serves VLESS.
- The client connects to `https://<domain>:443<WS_PATH>` with TLS on and SNI
  set to the domain.

Environment variables (set in the Railway service, never committed here):
- `UUID` — the VLESS client id
- `WS_PATH` — the WebSocket path, e.g. `/your-random-path`

Deploy: Railway → New Project → Deploy from GitHub repo → pick this repo →
set `UUID` and `WS_PATH` in Variables → Settings → Networking → Generate Domain.
