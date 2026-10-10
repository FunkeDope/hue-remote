#!/usr/bin/env node
'use strict';

/*
 * Hue Remote, web version. Serves the same UI as the Android app (../web) and gives
 * it what MainActivity.java gives the Android WebView: HTTP to the bridge, bridge
 * discovery and saved settings. Plain Node, no dependencies.
 *
 *   node server/server.js [--port 8080] [--lan]
 *
 * By default only this computer can open the page. --lan also serves it to other
 * devices on your network (phones, tablets).
 */

const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const WEB_DIR = path.join(__dirname, '..', 'web');
const FILES = {
  '/app.js': [path.join(WEB_DIR, 'app.js'), 'text/javascript; charset=utf-8'],
  '/style.css': [path.join(WEB_DIR, 'style.css'), 'text/css; charset=utf-8'],
  '/icon.svg': [path.join(WEB_DIR, 'icon.svg'), 'image/svg+xml'],
  '/shim.js': [path.join(__dirname, 'shim.js'), 'text/javascript; charset=utf-8'],
};
const MAX_BODY = 1 << 20;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

// ---------- settings (bridge IP + username), shared by every browser ----------

function loadConfig(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cfg && cfg.prefs && typeof cfg.prefs === 'object' ? cfg : { prefs: {} };
  } catch {
    return { prefs: {} };
  }
}

function saveConfig(file, cfg) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// ---------- which addresses we'll talk to ----------

function isPrivateIPv4(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const isLoopback = (host) => host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);

/**
 * Only proxy to the bridge API on a LAN address, so this can't be used as an open
 * proxy. `ownAddresses` (this computer's LAN IPs) are refused too in --lan mode.
 */
function checkBridgeUrl(raw, allowLoopback, ownAddresses = []) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'Bad URL';
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:') return 'Only http:// bridge addresses are supported';
  if (!isPrivateIPv4(host) && !(allowLoopback && isLoopback(host))) {
    return 'Only bridges on your local network (a private IP address) are allowed';
  }
  if (ownAddresses.includes(host)) return "That's this computer, not a bridge";
  if (!url.pathname.startsWith('/api')) return 'Only the bridge API is allowed';
  return null;
}

/**
 * The page is only served under names that point at this machine. That blocks
 * DNS-rebinding tricks where some website points its own hostname at 127.0.0.1.
 */
function hostAllowed(hostHeader, extraHosts) {
  if (!hostHeader) return false;
  let host;
  try {
    host = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || net.isIP(host)) return true;
  const me = os.hostname().toLowerCase();
  if (['', '.local', '.lan', '.home', '.localdomain'].some((suffix) => host === me + suffix)) return true;
  return extraHosts.includes(host);
}

// ---------- HTTP to the bridge ----------

function request(method, url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body, 'utf8') : null;
    const headers = { Connection: 'close' }; // the v1 bridge is flaky with keep-alive
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    const req = http.request(url, { method, headers, agent: false, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) req.destroy(new Error('Response too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}

async function proxy({ method, url, body }, lan) {
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return { ok: false, error: 'Bad method' };
  // When other devices can use this, keep them off this computer's own ports.
  const problem = lan ? checkBridgeUrl(String(url), false, lanAddresses()) : checkBridgeUrl(String(url), true);
  if (problem) return { ok: false, error: problem };
  try {
    const r = await request(method, String(url), body ? String(body) : '', 8000);
    return { ok: true, status: r.status, body: r.body };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
}

// ---------- discovery: SSDP first, then a sweep of the local /24s ----------

function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && isPrivateIPv4(a.address)) out.push(a.address);
    }
  }
  return out;
}

function ssdpSearch(ms) {
  return new Promise((resolve) => {
    const found = new Set();
    const msg = Buffer.from([
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 2',
      'ST: ssdp:all',
      '', '',
    ].join('\r\n'));
    const sock = dgram.createSocket('udp4');
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve([...found]);
    };
    sock.on('error', finish);
    sock.on('message', (buf, rinfo) => {
      // v1 bridges announce "IpBridge" in SERVER; newer ones add hue-bridgeid.
      const text = buf.toString('utf8').toLowerCase();
      if (text.includes('ipbridge') || text.includes('hue-bridgeid')) found.add(rinfo.address);
    });
    const sendAll = async () => {
      // Send out of every LAN interface, not just the default route's.
      const addrs = lanAddresses();
      for (const addr of addrs.length ? addrs : [null]) {
        if (finished) return;
        try {
          if (addr) sock.setMulticastInterface(addr);
          await new Promise((done) => sock.send(msg, 1900, '239.255.255.250', () => done()));
        } catch {
          // interface went away or can't multicast; try the next one
        }
      }
    };
    sock.bind(0, () => {
      sendAll();
      setTimeout(sendAll, 1000);
      setTimeout(finish, ms);
    });
  });
}

async function sweepSubnets() {
  const prefixes = [...new Set(lanAddresses().map((ip) => ip.replace(/\d+$/, '')))].slice(0, 4);
  const ips = [];
  for (const prefix of prefixes) for (let i = 1; i < 255; i++) ips.push(prefix + i);
  const found = [];
  let next = 0;
  const worker = async () => {
    while (next < ips.length) {
      const ip = ips[next++];
      try {
        const r = await request('GET', `http://${ip}/description.xml`, '', 800);
        if (r.status === 200 && /hue bridge|meethue/i.test(r.body)) found.push(ip);
      } catch {
        // nothing there
      }
    }
  };
  await Promise.all(Array.from({ length: 64 }, worker));
  return found;
}

async function findBridges() {
  const viaSsdp = await ssdpSearch(3000);
  return viaSsdp.length ? viaSsdp : sweepSubnets();
}

// ---------- the web server ----------

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': type }, SECURITY_HEADERS, headers));
  res.end(body);
}

const sendJson = (res, obj) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(obj));

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function createServer({ lan = false, configPath = path.join(__dirname, 'config.json'), extraHosts = [] } = {}) {
  const config = loadConfig(configPath);

  function indexHtml() {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    const boot = JSON.stringify({ prefs: config.prefs, deviceName: os.hostname() }).replace(/</g, '\\u003c');
    const tag = '<script src="app.js"></script>';
    if (!html.includes(tag)) throw new Error(`web/index.html no longer contains ${tag}`);
    return html.replace(tag, `<script>window.__HUE_BOOT__ = ${boot};</script>\n  <script src="shim.js"></script>\n  ${tag}`);
  }

  async function handle(req, res) {
    if (!hostAllowed(req.headers.host, extraHosts)) return send(res, 403, 'text/plain', 'Unknown host name');
    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/' || pathname === '/index.html') return send(res, 200, 'text/html; charset=utf-8', indexHtml());
      const file = FILES[pathname];
      if (file) return send(res, 200, file[1], fs.readFileSync(file[0]));
      return send(res, 404, 'text/plain', 'Not found');
    }

    if (req.method === 'POST' && pathname.startsWith('/native/')) {
      // Same-origin JSON only: other websites open in the browser can't call these.
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, 'text/plain', 'Cross-origin request');
      if (!String(req.headers['content-type']).startsWith('application/json')) {
        return send(res, 415, 'text/plain', 'Expected application/json');
      }
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, 'text/plain', 'Bad JSON');
      }
      if (pathname === '/native/http') return sendJson(res, await proxy(body, lan));
      if (pathname === '/native/discover') return sendJson(res, { ok: true, bridges: await findBridges() });
      if (pathname === '/native/pref') {
        const { key, value } = body;
        if (!/^[A-Za-z]{1,32}$/.test(String(key)) || typeof value !== 'string' || value.length > 256) {
          return send(res, 400, 'text/plain', 'Bad setting');
        }
        if (value) config.prefs[key] = value;
        else delete config.prefs[key];
        saveConfig(configPath, config);
        return sendJson(res, { ok: true });
      }
    }
    return send(res, 404, 'text/plain', 'Not found');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, 'text/plain', 'Server error');
    });
  });
}

// ---------- command line ----------

function parseArgs(argv) {
  const opts = { port: Number(process.env.PORT) || 8080, lan: process.env.HUE_LAN === '1' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lan') opts.lan = true;
    else if (arg === '--port' || arg === '-p') opts.port = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error('--port needs a number from 1 to 65535');
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nUsage: node server/server.js [--port 8080] [--lan]`);
    process.exit(1);
  }
  if (opts.help) {
    console.log('Usage: node server/server.js [--port 8080] [--lan]\n\n'
      + '  --port, -p  port to serve on (default 8080, or $PORT)\n'
      + '  --lan       let other devices on your network open it too (or HUE_LAN=1)\n\n'
      + 'Settings are saved to server/config.json (or $HUE_CONFIG).');
    return;
  }
  const extraHosts = (process.env.HUE_ALLOWED_HOSTS || '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean);
  const server = createServer({ lan: opts.lan, configPath: process.env.HUE_CONFIG || undefined, extraHosts });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE'
      ? `Port ${opts.port} is already in use. Try another one: npm start -- --port ${opts.port + 1}`
      : e.message);
    process.exit(1);
  });
  server.listen(opts.port, opts.lan ? '0.0.0.0' : '127.0.0.1', () => {
    console.log('Hue Remote is running. Open it in your browser:\n');
    console.log(`  http://localhost:${opts.port}/`);
    if (opts.lan) {
      for (const ip of lanAddresses()) console.log(`  http://${ip}:${opts.port}/   (from other devices)`);
    }
    console.log('\nPress Ctrl+C to stop.');
  });
}

if (require.main === module) main();

module.exports = { createServer, checkBridgeUrl, hostAllowed, isPrivateIPv4 };
