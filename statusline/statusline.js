// TokenSyber statusline: show tokens injected + pending delta + Worker connection status.
// Reads player.json for player ID, queries Worker /fuel-stats for connection status.

let buf = '';
process.stdin.on('data', c => buf += c);
process.stdin.on('end', () => {
  const fs = require('fs');
  const path = require('path');
  const https = require('https');
  const home = require('os').homedir();

  const stateFile = path.join(home, '.tokensyber', 'state.json');
  const playerFile = path.join(home, '.tokensyber', 'player.json');

  // Read state.json for injectedTokens + lastTokens
  let injected = 0, lastTokens = 0;
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    injected = s.injectedTokens || 0;
    lastTokens = s.lastTokens || 0;
  } catch {}

  // Compute pending delta from live transcript
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

  // Read player.json for player ID
  let playerId = '';
  try {
    const p = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
    playerId = p.playerId || '';
  } catch {}

  let done = false;
  const output = (connected) => {
    if (done) return;
    done = true;
    if (connected) {
      process.stdout.write(display > 0
        ? `\u{1F525} TokenSyber: ${display.toLocaleString('en-US')} tokens`
        : '\u{1F525} TokenSyber: 等待对话');
    } else {
      process.stdout.write(playerId
        ? '\u{1F4A8} TokenSyber: 未连接 · 发起对话刷新'
        : '\u{1F4A8} TokenSyber: 未配置');
    }
  };

  if (!playerId) {
    output(false);
    return;
  }

  // Query Worker for connection status
  const WORKER_URL = `https://tokensyber.pages.dev/fuel-stats?player=${playerId}`;
  const req = https.get(WORKER_URL, { timeout: 2000 }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      let connected = false;
      try {
        const data = JSON.parse(body);
        connected = data.connected === true;
      } catch {}
      output(connected);
    });
  });
  req.on('error', () => output(false));
  req.on('timeout', () => {
    req.destroy();
    // destroy() triggers error event → output(false), no need to call twice
  });
});
