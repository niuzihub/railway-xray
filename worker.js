// VLESS over WebSocket (Cloudflare Workers).
// Same protocol as xray VLESS+WS+TLS: UUID + WS path checked here,
// Cloudflare terminates TLS at the edge, Worker relays TCP/UDP.
// Set Worker Variables UUID and WS_PATH in the dashboard (do NOT hardcode
// them here, this file is public). Deploy as a Worker, enable workers.dev.
import { connect } from 'cloudflare:sockets';

let cachedUuid = '';
let cachedUuidBytes = null;

function uuidBytesFor(uuid) {
  if (uuid === cachedUuid && cachedUuidBytes) return cachedUuidBytes;
  const h = uuid.replace(/-/g, '');
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  cachedUuid = uuid;
  cachedUuidBytes = b;
  return b;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Queue of incoming WebSocket messages (Uint8Array chunks).
function makeMessageQueue(ws) {
  const queue = [];
  let resolver = null;
  let closed = false;
  const wake = (result) => {
    if (resolver) {
      const r = resolver;
      resolver = null;
      r(result);
    }
  };
  ws.addEventListener('message', (e) => {
    const data = typeof e.data === 'string'
      ? new TextEncoder().encode(e.data)
      : new Uint8Array(e.data);
    if (resolver) wake({ value: data, done: false });
    else queue.push(data);
  });
  const onEnd = () => {
    closed = true;
    wake({ value: undefined, done: true });
  };
  ws.addEventListener('close', onEnd);
  ws.addEventListener('error', onEnd);
  return {
    async next() {
      if (queue.length) return { value: queue.shift(), done: false };
      if (closed) return { value: undefined, done: true };
      return new Promise((res) => { resolver = res; });
    },
  };
}

// Parse a VLESS request header from buf. Returns null when more bytes are
// needed, { error: true } on a malformed header, otherwise the parsed header.
function tryParseVlessHeader(buf, uuidBytes) {
  if (buf.length < 18) return null;
  const uuid = buf.slice(1, 17);
  const addonLen = buf[17];
  let off = 18 + addonLen;
  if (buf.length < off + 4) return null;
  const command = buf[off];
  off += 1;
  const port = (buf[off] << 8) | buf[off + 1];
  off += 2;
  const type = buf[off];
  off += 1;
  let address;
  if (type === 1) {
    if (buf.length < off + 4) return null;
    address = Array.from(buf.slice(off, off + 4)).join('.');
    off += 4;
  } else if (type === 2) {
    const len = buf[off];
    off += 1;
    if (buf.length < off + len) return null;
    address = new TextDecoder().decode(buf.slice(off, off + len));
    off += len;
  } else if (type === 3) {
    if (buf.length < off + 16) return null;
    const parts = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(((buf[off + i] << 8) | buf[off + i + 1]).toString(16));
    }
    address = parts.join(':');
    off += 16;
  } else {
    return { error: true };
  }
  let uuidOk = true;
  for (let i = 0; i < 16; i++) {
    if (uuid[i] !== uuidBytes[i]) {
      uuidOk = false;
      break;
    }
  }
  return { uuidOk, command, port, address, headerLength: off };
}

async function handleTCP(ws, queue, address, port, firstData) {
  let socket;
  try {
    socket = connect({ hostname: address, port });
  } catch {
    ws.close();
    return;
  }
  const writer = socket.writable.getWriter();
  let firstOut = true;
  const sendToClient = (data) => {
    if (ws.readyState !== 1) return;
    if (firstOut) {
      firstOut = false;
      const out = new Uint8Array(2 + data.length);
      out[0] = 0; // VLESS response: version 0
      out[1] = 0; // addon length 0
      out.set(data, 2);
      ws.send(out);
    } else {
      ws.send(data);
    }
  };
  const pumpOut = (async () => {
    const reader = socket.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) sendToClient(value);
      }
    } catch {
      // target closed / error
    }
    try { ws.close(); } catch {}
  })();
  const pumpIn = (async () => {
    try {
      if (firstData.length) await writer.write(firstData);
      for (;;) {
        const { value, done } = await queue.next();
        if (done) break;
        if (value && value.length) await writer.write(value);
      }
    } catch {
      // client closed / target error
    }
    try { await writer.close(); } catch {}
  })();
  await Promise.race([pumpOut, pumpIn]);
  try { socket.close(); } catch {}
  try { ws.close(); } catch {}
}

// One UDP packet from the client: [2B len][2B reserved][1B frag][1B type][addr][2B port][payload]
function parseUdpPacket(pkt) {
  if (pkt.length < 5) return null;
  let off = 2; // reserved
  const frag = pkt[off];
  off += 1;
  if (frag !== 0) return null; // fragmented packets not supported
  const type = pkt[off];
  off += 1;
  let address;
  if (type === 1) {
    if (pkt.length < off + 4 + 2) return null;
    address = Array.from(pkt.slice(off, off + 4)).join('.');
    off += 4;
  } else if (type === 2) {
    const len = pkt[off];
    off += 1;
    if (pkt.length < off + len + 2) return null;
    address = new TextDecoder().decode(pkt.slice(off, off + len));
    off += len;
  } else if (type === 3) {
    if (pkt.length < off + 16 + 2) return null;
    const parts = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(((pkt[off + i] << 8) | pkt[off + i + 1]).toString(16));
    }
    address = parts.join(':');
    off += 16;
  } else {
    return null;
  }
  const port = (pkt[off] << 8) | pkt[off + 1];
  off += 2;
  return { address, port, payload: pkt.slice(off) };
}

function encodeAddress(type, address) {
  if (type === 1) {
    return Uint8Array.from(address.split('.').map((n) => parseInt(n, 10)));
  }
  if (type === 2) {
    const b = new TextEncoder().encode(address);
    const out = new Uint8Array(1 + b.length);
    out[0] = b.length;
    out.set(b, 1);
    return out;
  }
  // IPv6
  const groups = address.split(':');
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] || '0', 16);
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

function addrTypeOf(address) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) return 1;
  if (address.includes(':')) return 3;
  return 2;
}

async function handleUDP(ws, queue, firstData) {
  const sockets = new Map(); // "address:port" -> { socket, writer }
  let firstOut = true;
  let buf = firstData;
  const sendPacket = (packet) => {
    // packet: full UDP response packet WITHOUT the 2-byte length prefix
    if (ws.readyState !== 1) return;
    const framed = new Uint8Array(2 + packet.length);
    framed[0] = (packet.length >> 8) & 0xff;
    framed[1] = packet.length & 0xff;
    framed.set(packet, 2);
    if (firstOut) {
      firstOut = false;
      const out = new Uint8Array(2 + framed.length);
      out[0] = 0; // VLESS response: version 0
      out[1] = 0; // addon length 0
      out.set(framed, 2);
      ws.send(out);
    } else {
      ws.send(framed);
    }
  };
  const getSocket = (address, port) => {
    const key = `${address}:${port}`;
    if (sockets.has(key)) return sockets.get(key);
    const socket = connect({ hostname: address, port });
    const writer = socket.writable.getWriter();
    const entry = { socket, writer };
    sockets.set(key, entry);
    // Read datagrams from this destination and relay them back.
    (async () => {
      const reader = socket.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          const type = addrTypeOf(address);
          const addrBytes = encodeAddress(type, address);
          const resp = new Uint8Array(2 + 1 + 1 + addrBytes.length + 2 + value.length);
          let o = 0;
          resp[o++] = 0; resp[o++] = 0; // reserved
          resp[o++] = 0; // fragment
          resp[o++] = type;
          resp.set(addrBytes, o); o += addrBytes.length;
          resp[o++] = (port >> 8) & 0xff;
          resp[o++] = port & 0xff;
          resp.set(value, o);
          sendPacket(resp);
        }
      } catch {
        // socket closed
      }
    })();
    return entry;
  };
  try {
    for (;;) {
      // Drain complete length-prefixed packets from buf, then read more.
      for (;;) {
        if (buf.length < 2) break;
        const len = (buf[0] << 8) | buf[1];
        if (buf.length < 2 + len) break;
        const pkt = buf.slice(2, 2 + len);
        buf = buf.slice(2 + len);
        const parsed = parseUdpPacket(pkt);
        if (!parsed) continue;
        try {
          const { writer } = getSocket(parsed.address, parsed.port);
          await writer.write(parsed.payload);
        } catch {
          // unreachable destination, drop
        }
      }
      const { value, done } = await queue.next();
      if (done) break;
      if (value && value.length) {
        const n = new Uint8Array(buf.length + value.length);
        n.set(buf);
        n.set(value, buf.length);
        buf = n;
      }
    }
  } catch {
    // client closed
  }
  for (const { socket } of sockets.values()) {
    try { socket.close(); } catch {}
  }
  try { ws.close(); } catch {}
}

async function handleConnection(ws, request, uuidBytes) {
  const queue = makeMessageQueue(ws);
  let buf = new Uint8Array(0);
  const append = (chunk) => {
    const n = new Uint8Array(buf.length + chunk.length);
    n.set(buf);
    n.set(chunk, buf.length);
    buf = n;
  };
  // 0-RTT early data some clients send in the subprotocol header.
  const proto = request.headers.get('Sec-WebSocket-Protocol');
  if (proto) {
    try { append(b64urlToBytes(proto)); } catch {}
  }
  let header = null;
  while (!header) {
    const { value, done } = await queue.next();
    if (done) return; // closed before a full header arrived
    append(value);
    header = tryParseVlessHeader(buf, uuidBytes);
  }
  if (header.error || !header.uuidOk) {
    ws.close();
    return;
  }
  const firstData = buf.slice(header.headerLength);
  if (header.command === 1) {
    await handleTCP(ws, queue, header.address, header.port, firstData);
  } else if (header.command === 2) {
    await handleUDP(ws, queue, firstData);
  } else {
    ws.close();
  }
}

export default {
  async fetch(request, env) {
    const wsPath = env.WS_PATH || '/';
    const uuidBytes = uuidBytesFor(env.UUID || '');
    const url = new URL(request.url);
    if (
      request.headers.get('Upgrade') !== 'websocket' ||
      url.pathname !== wsPath
    ) {
      return new Response('Not Found', { status: 404 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    handleConnection(server, request, uuidBytes).catch(() => {
      try { server.close(); } catch {}
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
