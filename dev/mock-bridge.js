#!/usr/bin/env node
// A fake v1 Hue bridge, for working on the app without the real one.
//
//   node dev/mock-bridge.js [port]     (default 8123)
//
// Run `npm start` alongside it and pair with "localhost:8123". (It also serves the
// UI itself at http://localhost:8123/ for quick CSS tweaks.) The fake link button
// counts as pressed on the third pairing attempt. Commands are logged.
//
// Light management is faked too: a search for new lights (POST /lights) runs for
// scan.durationMs and turns up one new light, lights can be renamed and deleted, and
// the bridge can be renamed or asked to touchlink.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number((require.main === module && process.argv[2]) || process.env.PORT || 8123);
const assets = path.join(__dirname, '..', 'web');
const USER = 'mockuser0123456789abcdef';
let pairAttempts = 0;

const lights = {
  1: {
    name: 'Left', type: 'Color light', modelid: 'LLC011', manufacturername: 'Philips',
    state: { on: false, bri: 200, hue: 8000, sat: 140, xy: [0.5, 0.4], effect: 'none', alert: 'none', colormode: 'hs', reachable: false },
  },
  2: {
    name: 'Right', type: 'Color light', modelid: 'LLC011', manufacturername: 'Philips',
    state: { on: true, bri: 180, hue: 0, sat: 254, xy: [0.67, 0.32], effect: 'none', alert: 'none', colormode: 'hs', reachable: true },
  },
};

const config = {
  name: 'Philips hue', modelid: 'BSB001', swversion: '01043155', apiversion: '1.16.0',
  mac: '00:17:88:00:00:00', zigbeechannel: 15, ipaddress: '127.0.0.1',
};

// A search for new lights: active for durationMs, adds one light part-way through.
const scan = { durationMs: 4000, startedAt: 0, lastscan: 'none', found: {}, serials: [], added: false };

function nextLightId() {
  return String(Math.max(0, ...Object.keys(lights).map(Number)) + 1);
}

function tickScan() {
  if (!scan.startedAt) return;
  const elapsed = Date.now() - scan.startedAt;
  if (!scan.added && elapsed > scan.durationMs / 3) {
    scan.added = true;
    const id = nextLightId();
    const serial = scan.serials[0];
    lights[id] = {
      name: serial ? `Hue lamp ${serial}` : `Hue color lamp ${id}`, type: 'Extended color light', modelid: 'LCT007',
      manufacturername: 'Philips', uniqueid: `00:17:88:01:00:${id.padStart(2, '0')}:00:00-0b`,
      state: { on: true, bri: 254, hue: 8418, sat: 140, ct: 366, effect: 'none', alert: 'none', colormode: 'ct', reachable: true },
    };
    scan.found[id] = { name: lights[id].name };
  }
  if (elapsed >= scan.durationMs) {
    scan.startedAt = 0;
    scan.lastscan = new Date().toISOString().slice(0, 19);
  }
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function setState(id, body, address) {
  const st = lights[id].state;
  const out = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === 'transitiontime') continue;
    if (k !== 'on' && k !== 'alert' && !st.on && !body.on) {
      out.push({ error: { type: 201, address: `${address}/${k}`, description: `parameter, ${k}, is not modifiable. Device is set to off.` } });
      continue;
    }
    st[k] = v;
    if (k === 'hue' || k === 'sat') st.colormode = 'hs';
    out.push({ success: { [`${address}/${k}`]: v } });
  }
  return out;
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = req.url.split('?')[0];
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(200, [{ error: { type: 2, address: '/', description: 'body contains invalid json' } }]); }
    if (raw && require.main === module) console.log(req.method, url, raw);

    // CORS preflight, answered the way the real bridge does, so the hosted website
    // (a page on another origin) can send PUTs.
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE, HEAD',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '3600',
      });
      return res.end();
    }

    if (req.method === 'GET' && !url.startsWith('/api') && url !== '/description.xml') {
      const file = path.join(assets, url === '/' ? 'index.html' : path.normalize(url));
      if (!file.startsWith(assets) || !fs.existsSync(file)) return send(404, 'not found', 'text/plain');
      return send(200, fs.readFileSync(file, 'utf8'), types[path.extname(file)] || 'text/plain');
    }
    if (url === '/description.xml') {
      return send(200, '<root><device><modelName>Philips hue bridge 2012</modelName></device></root>', 'text/xml');
    }
    if (req.method === 'POST' && url === '/api') {
      pairAttempts++;
      if (pairAttempts < 3) return send(200, [{ error: { type: 101, address: '', description: 'link button not pressed' } }]);
      pairAttempts = 0;
      return send(200, [{ success: { username: USER } }]);
    }

    const m = url.match(/^\/api\/([^/]+)(\/.*)?$/);
    if (!m) return send(404, 'not found', 'text/plain');
    const [, user, rest = ''] = m;
    if (user !== USER) return send(200, [{ error: { type: 1, address: rest || '/', description: 'unauthorized user' } }]);

    if (req.method === 'GET' && rest === '/lights') return send(200, lights);
    if (req.method === 'GET' && rest === '/config') return send(200, config);
    if (req.method === 'PUT' && rest === '/config') {
      const out = [];
      if ('name' in body) {
        if (typeof body.name !== 'string' || body.name.length < 4 || body.name.length > 16) {
          out.push({ error: { type: 7, address: '/config/name', description: `invalid value, ${body.name}, for parameter, name` } });
        } else {
          config.name = body.name;
          out.push({ success: { '/config/name': body.name } });
        }
      }
      if (body.touchlink === true) out.push({ success: { '/config/touchlink': true } });
      return send(200, out);
    }
    if (req.method === 'POST' && rest === '/lights') {
      tickScan();
      if (scan.startedAt) return send(200, [{ error: { type: 901, address: '/lights', description: 'Internal error, 501' } }]);
      scan.startedAt = Date.now();
      scan.lastscan = 'active';
      scan.found = {};
      scan.added = false;
      scan.serials = Array.isArray(body.deviceid) ? body.deviceid : [];
      return send(200, [{ success: { '/lights': 'Searching for new devices' } }]);
    }
    if (req.method === 'GET' && rest === '/lights/new') {
      tickScan();
      return send(200, Object.assign({ lastscan: scan.startedAt ? 'active' : scan.lastscan }, scan.found));
    }
    let lm = rest.match(/^\/lights\/(\d+)$/);
    if (req.method === 'PUT' && lm && lights[lm[1]]) {
      if (typeof body.name !== 'string' || !body.name.length || body.name.length > 32) {
        return send(200, [{ error: { type: 7, address: `/lights/${lm[1]}/name`, description: `invalid value, ${body.name}, for parameter, name` } }]);
      }
      lights[lm[1]].name = body.name;
      return send(200, [{ success: { [`/lights/${lm[1]}/name`]: body.name } }]);
    }
    if (req.method === 'DELETE' && lm && lights[lm[1]]) {
      delete lights[lm[1]];
      return send(200, [{ success: `/lights/${lm[1]} deleted` }]);
    }
    lm = rest.match(/^\/lights\/(\d+)\/state$/);
    if (req.method === 'PUT' && lm && lights[lm[1]]) return send(200, setState(lm[1], body, `/lights/${lm[1]}/state`));
    lm = rest.match(/^\/groups\/0\/action$/);
    if (req.method === 'PUT' && lm) {
      for (const id of Object.keys(lights)) setState(id, body, `/lights/${id}/state`);
      return send(200, Object.keys(body).map((k) => ({ success: { [`/groups/0/action/${k}`]: body[k] } })));
    }
    return send(200, [{ error: { type: 3, address: rest, description: `resource, ${rest}, not available` } }]);
  });
});

if (require.main === module) {
  server.listen(port, () => console.log(`mock bridge on http://localhost:${port}/ (pair with "localhost:${port}")`));
}
module.exports = { server, lights, config, scan, USER };
