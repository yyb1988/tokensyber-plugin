const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ========== WebSocket Protocol (RFC 6455) ==========

const OPCODES = { TEXT: 0x01, CLOSE: 0x08, PING: 0x09, PONG: 0x0A };
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

function encodeFrame(opcode, payload) {
  const fin = 0x80;
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = fin | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = fin | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = fin | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const secondByte = buffer[1];
  const opcode = buffer[0] & 0x0F;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLen = secondByte & 0x7F;
  let offset = 2;

  if (!masked) throw new Error('Client frames must be masked');

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  const maskOffset = offset;
  const dataOffset = offset + 4;
  const totalLen = dataOffset + payloadLen;
  if (buffer.length < totalLen) return null;

  const mask = buffer.slice(maskOffset, dataOffset);
  const data = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    data[i] = buffer[dataOffset + i] ^ mask[i % 4];
  }

  return { opcode, payload: data, bytesConsumed: totalLen };
}

// ========== Configuration ==========

const DEFAULT_PORT = 3001;
const MAX_PORT = 3010;
const HTTPS_PORT_OFFSET = 10;  // HTTPS on 3011-3020
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const STATE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.tokensyber'
);

const PID_FILE = path.join(STATE_DIR, 'server.pid');
const SERVER_INFO_FILE = path.join(STATE_DIR, 'server.json');
const CERT_FILE = path.join(STATE_DIR, 'server-cert.pem');
const KEY_FILE = path.join(STATE_DIR, 'server-key.pem');

let totalTokens = 0;
let totalRequests = 0;
let actualPort = null;
let actualHttpsPort = null;

// ========== WebSocket Clients ==========

const clients = new Set();

function broadcast(msg) {
  const frame = encodeFrame(OPCODES.TEXT, Buffer.from(JSON.stringify(msg)));
  for (const socket of clients) {
    try { socket.write(frame); } catch (e) { clients.delete(socket); }
  }
}

function broadcastTokenConsumed(tokens) {
  // Only accumulate when game client is connected
  if (clients.size > 0) {
    totalTokens += tokens;
    totalRequests++;
  }
  broadcast({
    type: 'token-consumed',
    tokens,
    totalTokens,
    timestamp: Date.now(),
  });
}

// ========== HTTP Handler ==========

function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (req.url === '/fuel-port') {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ port: actualPort, httpsPort: actualHttpsPort, server: 'tokensyber' }));
    return;
  }

  if (req.url === '/fuel-stats') {
    res.writeHead(200, headers);
    res.end(JSON.stringify({
      totalTokens,
      totalRequests,
      clients: clients.size,
      port: actualPort,
      httpsPort: actualHttpsPort,
    }));
    return;
  }

  if (req.url?.startsWith('/fuel-inject')) {
    const params = new URL(req.url, `http://localhost:${actualPort}`);
    const tokens = parseInt(params.searchParams.get('tokens') || '5000', 10);
    broadcastTokenConsumed(tokens);
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, tokens, totalTokens, clients: clients.size }));
    return;
  }

  res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
  res.end();
}

// ========== WebSocket Upgrade ==========

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = computeAcceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  let buffer = Buffer.alloc(0);
  socket.isAlive = true;
  clients.add(socket);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      let result;
      try {
        result = decodeFrame(buffer);
      } catch (e) {
        socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
        clients.delete(socket);
        return;
      }
      if (!result) break;
      buffer = buffer.slice(result.bytesConsumed);

      switch (result.opcode) {
        case OPCODES.TEXT: {
          try {
            const msg = JSON.parse(result.payload.toString());
            if (msg.type === 'ping') {
              socket.write(encodeFrame(OPCODES.TEXT, Buffer.from(JSON.stringify({ type: 'pong' }))));
            }
          } catch { /* ignore */ }
          break;
        }
        case OPCODES.CLOSE:
          socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
          clients.delete(socket);
          return;
        case OPCODES.PING:
          socket.write(encodeFrame(OPCODES.PONG, result.payload));
          break;
        case OPCODES.PONG:
          socket.isAlive = true;
          break;
        default: {
          const closeBuf = Buffer.alloc(2);
          closeBuf.writeUInt16BE(1003);
          socket.end(encodeFrame(OPCODES.CLOSE, closeBuf));
          clients.delete(socket);
          return;
        }
      }
    }
  });

  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));

  // Send connected message
  const connected = encodeFrame(OPCODES.TEXT, Buffer.from(JSON.stringify({
    type: 'connected',
    message: 'TokenSyber Fuel Pump connected',
    stats: { totalTokens, totalRequests },
  })));
  socket.write(connected);
}

// ========== Server Lifecycle ==========

function startServer() {
  tryPort(DEFAULT_PORT);
}

function tryPort(port) {
  if (port > MAX_PORT) {
    console.error(JSON.stringify({ type: 'server-error', error: `Ports ${DEFAULT_PORT}-${MAX_PORT} all in use` }));
    process.exit(1);
  }

  const httpServer = http.createServer(handleRequest);
  httpServer.on('upgrade', handleUpgrade);

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      tryPort(port + 1);
    } else {
      console.error(JSON.stringify({ type: 'server-error', error: err.message }));
      process.exit(1);
    }
  });

  httpServer.listen(port, '0.0.0.0', () => {
    actualPort = port;
    const httpsPort = port + HTTPS_PORT_OFFSET;
    console.log(JSON.stringify({ type: 'server-started', port, httpsPort }));

    // Write PID file and server info file
    const dir = path.dirname(PID_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
    fs.writeFileSync(SERVER_INFO_FILE, JSON.stringify({
      port,
      httpsPort,
      pid: process.pid,
      startedAt: Date.now(),
    }));

    // Start HTTPS server if cert exists
    startHttpsServer(httpsPort);

    // Server-side heartbeat
    const heartbeat = setInterval(() => {
      for (const socket of clients) {
        if (!socket.isAlive) {
          socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
          clients.delete(socket);
          continue;
        }
        socket.isAlive = false;
        socket.write(encodeFrame(OPCODES.PING, Buffer.alloc(0)));
      }
    }, 30000);
    heartbeat.unref();

    // Clean up on exit
    function shutdown() {
      clearInterval(heartbeat);
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      try { fs.unlinkSync(SERVER_INFO_FILE); } catch { /* ignore */ }
      for (const socket of clients) {
        try { socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0))); } catch { /* ignore */ }
      }
      httpServer.close(() => process.exit(0));
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

function startHttpsServer(httpsPort) {
  // Read cert files
  let tlsOptions;
  try {
    tlsOptions = {
      key: fs.readFileSync(KEY_FILE),
      cert: fs.readFileSync(CERT_FILE),
    };
  } catch (e) {
    console.warn(JSON.stringify({ type: 'https-skipped', reason: 'No cert files found. WSS not available.' }));
    return;
  }

  const httpsServer = https.createServer(tlsOptions, handleRequest);
  httpsServer.on('upgrade', handleUpgrade);

  httpsServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(JSON.stringify({ type: 'https-port-in-use', port: httpsPort }));
    } else {
      console.warn(JSON.stringify({ type: 'https-error', error: err.message }));
    }
    // HTTPS is optional — don't exit, just skip
  });

  httpsServer.listen(httpsPort, '0.0.0.0', () => {
    actualHttpsPort = httpsPort;
    console.log(JSON.stringify({ type: 'https-started', port: httpsPort }));
    // Update server info with HTTPS port
    try {
      const info = JSON.parse(fs.readFileSync(SERVER_INFO_FILE, 'utf8'));
      info.httpsPort = httpsPort;
      fs.writeFileSync(SERVER_INFO_FILE, JSON.stringify(info));
    } catch { /* ignore */ }
  });
}

if (require.main === module) {
  startServer();
}
