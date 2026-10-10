'use strict';

// Tests for the web version's server, run against dev/mock-bridge.js: npm test

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createServer, checkBridgeUrl, hostAllowed } = require('../server/server.js');
const mock = require('../dev/mock-bridge.js');

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

/** Raw request, for headers fetch() won't let us set (Host). */
function rawRequest(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('web server', async (t) => {
  const bridgePort = await listen(mock.server);
  const bridge = `http://127.0.0.1:${bridgePort}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hue-remote-'));
  const configPath = path.join(dir, 'config.json');
  const app = createServer({ configPath });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;
  t.after(() => {
    app.close();
    mock.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const native = (name, data, headers = {}) => fetch(`${base}/native/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });
  const proxy = async (data) => (await native('http', data)).json();

  await t.test('serves the UI with the shim injected before app.js', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /window\.__HUE_BOOT__ = [\s\S]*shim\.js[\s\S]*app\.js/);
    for (const file of ['/app.js', '/style.css', '/icon.svg', '/shim.js']) {
      assert.equal((await fetch(base + file)).status, 200, file);
    }
    assert.equal((await fetch(`${base}/server.js`)).status, 404);
    assert.equal(await rawRequest(port, { path: '/../server/config.json' }), 404);
  });

  await t.test('proxies the v1 API to the bridge', async () => {
    const pair = await proxy({ method: 'POST', url: `${bridge}/api`, body: '{"devicetype":"test#test"}' });
    assert.equal(pair.ok, true);
    assert.equal(JSON.parse(pair.body)[0].error.type, 101); // link button not pressed

    const lights = await proxy({ method: 'GET', url: `${bridge}/api/${mock.USER}/lights`, body: '' });
    assert.equal(JSON.parse(lights.body)['2'].name, 'Right');

    const put = await proxy({ method: 'PUT', url: `${bridge}/api/${mock.USER}/lights/2/state`, body: '{"on":false}' });
    assert.ok(JSON.parse(put.body)[0].success);
    assert.equal(mock.lights[2].state.on, false);

    const down = await proxy({ method: 'GET', url: 'http://127.0.0.1:1/api/x/lights' });
    assert.equal(down.ok, false);
  });

  await t.test('manages lights: rename, blink, remove, add, bridge name', async () => {
    const api = `${bridge}/api/${mock.USER}`;
    const call = async (method, url, body) => JSON.parse((await proxy({ method, url, body: body ? JSON.stringify(body) : '' })).body);

    assert.ok((await call('PUT', `${api}/lights/1`, { name: 'Bedroom' }))[0].success);
    assert.equal(mock.lights[1].name, 'Bedroom');
    assert.equal((await call('PUT', `${api}/lights/1`, { name: '' }))[0].error.type, 7);

    const blink = await call('PUT', `${api}/lights/1/state`, { alert: 'select' });
    assert.ok(blink[0].success, 'alert works on a light that is off');

    assert.ok((await call('DELETE', `${api}/lights/1`))[0].success);
    assert.equal(mock.lights[1], undefined);

    assert.ok((await call('PUT', `${api}/config`, { name: 'Hallway hub' }))[0].success);
    assert.equal(mock.config.name, 'Hallway hub');
    assert.equal((await call('PUT', `${api}/config`, { name: 'ab' }))[0].error.type, 7);
    assert.ok((await call('PUT', `${api}/config`, { touchlink: true }))[0].success);

    mock.scan.durationMs = 300;
    assert.ok((await call('POST', `${api}/lights`, { deviceid: ['3A7F2C'] }))[0].success);
    assert.equal((await call('GET', `${api}/lights/new`)).lastscan, 'active');
    await new Promise((r) => setTimeout(r, 350));
    const after = await call('GET', `${api}/lights/new`);
    assert.notEqual(after.lastscan, 'active');
    const added = Object.keys(after).filter((k) => k !== 'lastscan');
    assert.equal(added.length, 1);
    assert.equal(after[added[0]].name, 'Hue lamp 3A7F2C');
    assert.equal(mock.lights[added[0]].name, 'Hue lamp 3A7F2C');
  });

  await t.test('only proxies to a bridge API on the local network', async () => {
    const urls = [
      'http://8.8.8.8/api',
      'http://example.com/api',
      'https://192.168.1.2/api',
      'file:///etc/passwd',
      `${bridge}/description.xml`,
    ];
    for (const url of urls) assert.equal((await proxy({ method: 'GET', url })).ok, false, url);
    assert.equal((await proxy({ method: 'PATCH', url: `${bridge}/api` })).ok, false);
  });

  await t.test('rejects cross-site and DNS-rebinding requests', async () => {
    assert.equal((await native('http', {}, { Origin: 'http://evil.example' })).status, 403);
    const plain = await fetch(`${base}/native/http`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(plain.status, 415);
    assert.equal(await rawRequest(port, { path: '/', headers: { Host: 'evil.example' } }), 403);
  });

  await t.test('saves settings and hands them to the next page load', async () => {
    assert.equal((await native('pref', { key: 'ip', value: '10.0.0.5' })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).prefs.ip, '10.0.0.5');
    assert.match(await (await fetch(`${base}/`)).text(), /"ip":"10\.0\.0\.5"/);

    await native('pref', { key: 'ip', value: '' });
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).prefs.ip, undefined);
    assert.equal((await native('pref', { key: '../x', value: 'y' })).status, 400);
  });
});

test('LAN mode keeps other devices off this computer\'s own ports', () => {
  assert.equal(checkBridgeUrl('http://10.1.10.232/api', false), null);
  assert.equal(checkBridgeUrl('http://192.168.1.20/api/abc/lights', false), null);
  assert.notEqual(checkBridgeUrl('http://127.0.0.1:8123/api', false), null);
  assert.notEqual(checkBridgeUrl('http://10.1.10.50/api', false, ['10.1.10.50']), null);
  assert.equal(checkBridgeUrl('http://localhost:8123/api', true), null);
});

test('page is only served under names for this computer', () => {
  assert.ok(hostAllowed('localhost:8080', []));
  assert.ok(hostAllowed('10.1.10.50:8080', []));
  assert.ok(hostAllowed('[::1]:8080', []));
  assert.ok(hostAllowed(`${os.hostname()}:8080`, []));
  assert.ok(hostAllowed(`${os.hostname()}.local:8080`, []));
  assert.ok(!hostAllowed('evil.example:8080', []));
  assert.ok(!hostAllowed(`${os.hostname()}.evil.example`, []));
  assert.ok(!hostAllowed(undefined, []));
  assert.ok(hostAllowed('hue.example', ['hue.example']));
});
