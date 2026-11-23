import express from 'express';
import type { SetupService, PortalHandle } from './setupService';
import { parseWifiRequest } from './wifiRequest';

const GATEWAY_URL = 'http://10.42.0.1/';

// SSIDs are attacker-controlled: the page only ever inserts them via DOM
// properties (textContent / option.value), never as HTML.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Photo Frame WiFi setup</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #111; color: #eee; }
  main { max-width: 420px; margin: 0 auto; }
  label { display: block; margin: 16px 0 6px; }
  select, input, button { width: 100%; box-sizing: border-box; padding: 12px; font-size: 16px; border-radius: 8px; border: 1px solid #444; background: #222; color: #eee; }
  button { background: #3b82f6; border: 0; margin-top: 20px; }
  .check { display: flex; gap: 8px; align-items: center; }
  .check input { width: auto; }
  #done { display: none; }
</style>
</head>
<body>
<main>
  <h1>Connect your frame to WiFi</h1>
  <form id="form">
    <label for="net">Network</label>
    <select id="net"></select>
    <label for="ssid">Or type a network name</label>
    <input id="ssid" autocapitalize="none" autocomplete="off" maxlength="32">
    <label for="pw">Password</label>
    <input id="pw" type="password" autocomplete="off" maxlength="63">
    <label class="check"><input id="hidden" type="checkbox"> Hidden network</label>
    <button type="submit">Connect</button>
  </form>
  <p id="done">Reconnect your phone to your home WiFi — the frame's screen will tell you if it worked.</p>
</main>
<script>
(function () {
  var net = document.getElementById('net');
  var ssid = document.getElementById('ssid');
  fetch('/networks').then(function (r) { return r.json(); }).then(function (list) {
    list.forEach(function (n) {
      var o = document.createElement('option');
      o.value = n.ssid;
      o.textContent = n.ssid + (n.secured ? ' (secured)' : '');
      net.appendChild(o);
    });
  }).catch(function () {});
  document.getElementById('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = ssid.value || net.value;
    if (!name) return;
    fetch('/wifi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: name, password: document.getElementById('pw').value || null, hidden: document.getElementById('hidden').checked })
    }).catch(function () {});
    document.getElementById('form').style.display = 'none';
    document.getElementById('done').style.display = 'block';
  });
})();
</script>
</body>
</html>`;

export function startPortal(service: SetupService, port = 80): PortalHandle {
  const app = express();
  app.use(express.json({ limit: '4kb' }));

  app.get('/', (_req, res) => {
    res.type('html').send(PAGE);
  });

  app.get('/networks', async (_req, res) => {
    res.json(await service.scanNetworks());
  });

  app.post('/wifi', (req, res) => {
    const parsed = parseWifiRequest(req.body);
    if (!parsed) {
      res.status(400).json({ error: 'Invalid WiFi details' });
      return;
    }
    res.status(202).json({ accepted: true });
    service.submitWifi(parsed.ssid, parsed.password, parsed.hidden).catch(() => {
      console.error('[portal] wifi submit failed');
    });
  });

  // Captive-portal probes and anything else: send the client to the setup page.
  app.use((_req, res) => {
    res.redirect(302, GATEWAY_URL);
  });

  const handle: PortalHandle = { port, close: () => {} };
  const server = app.listen(port, '0.0.0.0', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') handle.port = addr.port;
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[portal] could not listen on port ${port}: ${err.code ?? 'error'}`);
  });
  handle.close = () => {
    server.close();
    server.closeAllConnections();
  };
  return handle;
}
