#!/usr/bin/env node
// A fake v1 Hue bridge, for working on the app without the real one.
//
//   node dev/mock-bridge.js [port]     (default 8123)
//
// Run `npm start` alongside it and pair with "localhost:8123". (It also serves the
// UI itself at http://localhost:8123/ for quick CSS tweaks.) The fake link button
// counts as pressed on the third pairing attempt. Commands are logged.
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

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function setState(id, body, address) {
  const st = lights[id].state;
  const out = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === 'transitiontime') continue;
    if (k !== 'on' && !st.on && !body.on) {
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
    let lm = rest.match(/^\/lights\/(\d+)\/state$/);
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
module.exports = { server, lights, USER };
