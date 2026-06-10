// TokenSyber statusline: show tokens actually injected into the game for this context.
// Reads injectedTokens from state.json + computes pending delta from live transcript.
// Queries server /fuel-stats to check if game client is connected.
// Reads server.json for fast port discovery (avoids unreliable port scanning).

let buf = '';
process.stdin.on('data', c => buf += c);
process.stdin.on('end', () => {
  const fs = require('fs');
  const path = require('path');
  const http = require('http');
  const home = require('os').homedir();
  const stateFile = path.join(home, '.tokensyber', 'state.json');
  const serverInfoFile = path.join(home, '.tokensyber', 'server.json');

  // Read state.json for injectedTokens + lastTokens
  let injected = 0, lastTokens = 0;
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    injected = s.injectedTokens || 0;
    lastTokens = s.lastTokens || 0;
  } catch {}

  // Compute pending delta from live transcript (tokens not yet injected by stop hook)
  let pending = 0;
  try {
    const input = JSON.parse(buf || '{}');
    const tp = input.transcript_path;
    if (tp && fs.existsSync(tp)) {
      const lines = fs.readFileSync(tp, 'utf8').split('\n');
      let total = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.type === 'assistant') {
            const u = (o.message && o.message.usage) || {};
            total += (u.input_tokens || 0) + (u.output_tokens || 0);
          }
        } catch {}
      }
      pending = Math.max(total - lastTokens, 0);
    }
  } catch {}

  const display = injected + pending;

  // Try reading server.json for fast port discovery (no HTTP scanning needed)
  let knownPort = null;
  try {
    const info = JSON.parse(fs.readFileSync(serverInfoFile, 'utf8'));
    if (typeof info.port === 'number' && info.port >= 3001 && info.port <= 3010) {
      // Verify the PID is still alive (stale server.json check)
      let pidAlive = false;
      try {
        process.kill(info.pid, 0);
        pidAlive = true;
      } catch {}
      if (pidAlive) {
        knownPort = info.port;
      } else {
        // Stale file, clean it up
        try { fs.unlinkSync(serverInfoFile); } catch {}
      }
    }
  } catch {}

  // Query /fuel-stats on a specific port, return {connected, clients}
  const queryStats = (port, callback) => {
    const req = http.get(`http://127.0.0.1:${port}/fuel-stats`, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        let connected = false;
        try {
          const data = JSON.parse(body);
          // Verify this is actually the tokensyber server
          if (data.port !== undefined && data.totalTokens !== undefined) {
            connected = data.clients > 0;
          }
        } catch {}
        callback(connected);
      });
    });
    req.on('error', () => callback(null)); // null = couldn't reach, try next
    req.on('timeout', () => {
      req.destroy();
      callback(null);
    });
  };

  const output = (connected) => {
    if (connected) {
      process.stdout.write(display > 0
        ? `\u{1F525} TokenSyber: ${display.toLocaleString('en-US')} tokens`
        : '\u{1F525} TokenSyber: 等待对话');
    } else {
      process.stdout.write('\u{1F4A8} TokenSyber: 未连接 · 发起对话刷新');
    }
  };

  // Strategy: known port first (instant), then scan fallback
  if (knownPort !== null) {
    queryStats(knownPort, (connected) => {
      if (connected !== null) {
        output(connected);
      } else {
        // Server.json pointed to a dead port, fall back to scan
        scanPorts(3001, output);
      }
    });
  } else {
    scanPorts(3001, output);
  }

  function scanPorts(port, done) {
    if (port > 3010) {
      done(false);
      return;
    }
    queryStats(port, (connected) => {
      if (connected !== null) {
        // Got a response from this port (tokensyber or not)
        // If it's tokensyber (verified by queryStats), use the result
        // If not tokensyber, connected would be false, try next port
        if (connected === true) {
          done(true);
        } else {
          // connected is false (tokensyber found but no clients) or null was already handled
          // Need to check: did we actually reach tokensyber?
          // queryStats returns null for unreachable, false for "reached but no clients"
          // We can't distinguish "reached non-tokensyber" from "reached tokensyber with 0 clients"
          // Let's verify with /fuel-port to check if this is actually our server
          verifyAndContinue(port, done);
        }
      } else {
        // Couldn't reach this port, try next
        scanPorts(port + 1, done);
      }
    });
  }

  function verifyAndContinue(port, done) {
    const req = http.get(`http://127.0.0.1:${port}/fuel-port`, { timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        let isTokenSyber = false;
        try {
          const data = JSON.parse(body);
          isTokenSyber = data.server === 'tokensyber';
        } catch {}
        if (isTokenSyber) {
          // This IS our server, just no clients connected
          done(false);
        } else {
          // Not our server, continue scanning
          scanPorts(port + 1, done);
        }
      });
    });
    req.on('error', () => scanPorts(port + 1, done));
    req.on('timeout', () => {
      req.destroy();
      scanPorts(port + 1, done);
    });
  }
});
