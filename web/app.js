'use strict';

/*
 * Hue Remote: pairs with a Hue bridge and controls its lights over the local v1 REST API.
 * Built and tested on the original round bridge (BSB001); nothing here is model-specific.
 *
 * HTTP to the bridge, discovery and settings go through window.Native when there is
 * one: the Android app provides it (MainActivity.java), and the Node web version
 * provides it through server/shim.js. Without it, as on the hosted website, the page
 * talks to the bridge itself with fetch() and saves its settings in localStorage.
 */

const $ = (id) => document.getElementById(id);
const Native = window.Native || null;
const BROWSER = !Native; // plain web page: needs the browser's local network permission

const S = {
  ip: '',
  user: '',
  lights: {},          // id -> light object from GET /lights, patched as we send changes
  touched: {},         // id -> time of our last change, so polling doesn't undo it
  expanded: new Set(), // cards with the custom color sliders open
  view: '',
  pairing: null,       // { cancelled } while waiting for the link button
  returnToLights: false,
};

// ---------- transport ----------

const callbacks = new Map();
let callSeq = 0;

window.__nativeCb = (result) => {
  const done = callbacks.get(result.id);
  if (done) {
    callbacks.delete(result.id);
    done(result);
  }
};

function callNative(method, ...args) {
  return new Promise((resolve) => {
    const id = String(++callSeq);
    callbacks.set(id, resolve);
    Native[method](id, ...args);
  });
}

async function http(method, url, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  if (Native) {
    const r = await callNative('http', method, url, text);
    if (!r.ok) throw new Error(r.error || 'Network error');
    return r.body;
  }
  // Straight from the page. On an https site, Chrome/Edge (142+) first ask the user to
  // allow local network access; once allowed, a bridge at a private IP may be called
  // over plain http. The bridge's CORS headers (Access-Control-Allow-Origin: *) let the
  // page read the replies.
  const res = await localFetch(url, { method, body: text || undefined }, 8000);
  return res.text();
}

/** fetch() from the page itself, with a timeout, marked as local when it's a LAN IP. */
async function localFetch(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const init = Object.assign({ credentials: 'omit', cache: 'no-store', signal: ctrl.signal }, opts);
  if (isPrivateIPv4(new URL(url).hostname)) init.targetAddressSpace = 'local';
  try {
    return await fetch(url, init);
  } finally {
    clearTimeout(timer);
  }
}

function isPrivateIPv4(host) {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** The browser's local network permission (Chrome/Edge), or null if it has none to ask. */
async function localNetworkPermission() {
  if (!navigator.permissions) return null;
  for (const name of ['local-network-access', 'local-network']) {
    try {
      return await navigator.permissions.query({ name });
    } catch {
      // this browser doesn't know that permission name
    }
  }
  return null;
}

/** True when the user has blocked this site's local network access. */
async function localNetworkBlocked() {
  const status = await localNetworkPermission();
  return Boolean(status && status.state === 'denied');
}

/** A "can't reach the bridge" message, with what to do about the browser's permission. */
async function unreachable(message) {
  if (!BROWSER) return message;
  if (await localNetworkBlocked()) {
    return `${message} Your browser is blocking this site from your local network: click the icon at the left of the address bar, open the site settings, set Local network access to Allow, then reload.`;
  }
  return `${message} If your browser asks to let this site access devices on your local network, choose Allow.`;
}

class NotHueError extends Error {}

async function hue(method, path, body, ip = S.ip) {
  const text = await http(method, `http://${ip}${path}`, body);
  try {
    return JSON.parse(text);
  } catch {
    throw new NotHueError("That address answered, but it doesn't look like a Hue bridge.");
  }
}

/** The v1 API reports errors as [{ error: { type, address, description } }]. */
function firstError(reply) {
  if (!Array.isArray(reply)) return null;
  const item = reply.find((r) => r && r.error);
  return item ? item.error : null;
}

const prefs = {
  get(key) {
    try {
      return (Native ? Native.getPref(key) : localStorage.getItem(key)) || '';
    } catch {
      return '';
    }
  },
  set(key, value) {
    try {
      if (Native) Native.setPref(key, value);
      else localStorage.setItem(key, value);
    } catch {
      // storage unavailable; the app still works for this session
    }
  },
};

// ---------- color ----------

// Hue's hue scale isn't the CSS color wheel: 0 = red, 25500 = green, 46920 = blue, 65535 = red.
const HUE_STOPS = [[0, 0], [25500, 120], [46920, 240], [65535, 360]];

function lerpStops(value, from, to) {
  for (let i = 1; i < HUE_STOPS.length; i++) {
    const a = HUE_STOPS[i - 1];
    const b = HUE_STOPS[i];
    if (value <= b[from] || i === HUE_STOPS.length - 1) {
      const t = (value - a[from]) / (b[from] - a[from]);
      return a[to] + t * (b[to] - a[to]);
    }
  }
  return 0;
}
const hueToDeg = (h) => lerpStops(h, 0, 1);
const degToHue = (d) => Math.round(lerpStops(d, 1, 0));

function hsv(deg, s, v) {
  const l = v * (1 - s / 2);
  const sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return `hsl(${deg.toFixed(1)}, ${(sl * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%)`;
}

/** Approximate color of a white light at a color temperature (153 = cool, 500 = warm mired). */
function ctColor(ct, v = 1) {
  const t = Math.min(1, Math.max(0, (ct - 153) / 347));
  const cool = [222, 233, 255];
  const warm = [255, 172, 88];
  const [r, g, b] = cool.map((c, i) => Math.round((c + (warm[i] - c) * t) * v));
  return `rgb(${r}, ${g}, ${b})`;
}

function colorOf(st) {
  const v = st.bri === undefined ? 1 : 0.55 + 0.45 * (st.bri / 254);
  if (st.hue !== undefined && st.colormode !== 'ct') {
    return hsv(hueToDeg(st.hue), (st.sat === undefined ? 254 : st.sat) / 254, v);
  }
  return ctColor(st.ct === undefined ? 370 : st.ct, v);
}

function hueTrack() {
  const stops = [];
  for (let d = 0; d <= 360; d += 30) {
    stops.push(`hsl(${d}, 100%, 50%) ${((degToHue(d) / 65535) * 100).toFixed(2)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

const PRESETS = [
  { label: 'Warm white', deg: 33, sat: 110 },
  { label: 'White', deg: 40, sat: 0 },
  { label: 'Red', deg: 0, sat: 254 },
  { label: 'Orange', deg: 25, sat: 254 },
  { label: 'Yellow', deg: 52, sat: 254 },
  { label: 'Green', deg: 120, sat: 254 },
  { label: 'Cyan', deg: 185, sat: 254 },
  { label: 'Blue', deg: 240, sat: 254 },
  { label: 'Purple', deg: 275, sat: 254 },
  { label: 'Pink', deg: 320, sat: 200 },
].map((p) => Object.assign(p, { hue: degToHue(p.deg) }));

// ---------- sending changes ----------
// Slider drags fire far faster than the bridge (~10 commands/s) can take, so changes
// are merged per light and sent round-robin, never two at once for the same light.

const queue = new Map(); // 'light/3' | 'group/0' -> merged payload waiting to go out
const inFlight = new Set();
const GAP_MS = 100;
let lastSend = 0;
let pumpTimer = 0;

function send(key, payload) {
  const merged = payload.on === false ? { on: false } : Object.assign({}, queue.get(key), payload);
  queue.set(key, merged);
  pump();
}

function pump() {
  if (pumpTimer) return;
  const wait = lastSend + GAP_MS - Date.now();
  if (wait > 0) {
    pumpTimer = setTimeout(() => {
      pumpTimer = 0;
      pump();
    }, wait);
    return;
  }
  if (inFlight.size >= 2) return;
  const key = [...queue.keys()].find((k) => !inFlight.has(k));
  if (!key) return;

  const payload = queue.get(key);
  queue.delete(key);
  inFlight.add(key);
  lastSend = Date.now();
  const path = key === 'group/0'
    ? `/api/${S.user}/groups/0/action`
    : `/api/${S.user}/lights/${key.slice('light/'.length)}/state`;
  hue('PUT', path, payload)
    .then((reply) => {
      const err = firstError(reply);
      if (err) handleApiError(err);
    })
    .catch(() => toast("Couldn't reach the bridge."))
    .finally(() => {
      inFlight.delete(key);
      pump();
    });
  pump();
}

function handleApiError(err) {
  if (err.type === 1) unpaired();
  else toast(err.description);
}

/** Apply a change to a card's light(s): update local state right away, then queue it. */
function apply(target, change, fast) {
  const now = Date.now();
  if (target.all && 'on' in change) {
    for (const id of target.ids) {
      S.lights[id].state.on = change.on;
      S.touched[id] = now;
    }
    send('group/0', { on: change.on }); // group 0 = every light; switches them together
  } else {
    for (const id of target.ids) {
      const st = S.lights[id].state;
      const p = {};
      for (const k of Object.keys(change)) if (k === 'on' || k in st) p[k] = change[k];
      if (!Object.keys(p).length) continue; // e.g. color sent to a white-only bulb
      if (!('on' in p) && !st.on) p.on = true; // picking a color/brightness turns it on
      Object.assign(st, p);
      if ('hue' in p || 'sat' in p) st.colormode = 'hs';
      if ('ct' in p) st.colormode = 'ct';
      S.touched[id] = now;
      send(`light/${id}`, fast ? Object.assign({ transitiontime: 2 }, p) : p);
    }
  }
  syncCards();
}

// ---------- loading lights ----------

let refreshing = false;

async function refresh() {
  if (refreshing || !S.user) return;
  refreshing = true;
  $('refreshBtn').classList.add('spin');
  try {
    const data = await hue('GET', `/api/${S.user}/lights`);
    const err = firstError(data);
    if (err) {
      if (err.type === 1) unpaired();
      else setBanner(`Bridge error: ${err.description}`);
      return;
    }
    mergeLights(data);
    setBanner('');
  } catch (e) {
    setBanner(e instanceof NotHueError
      ? `${S.ip}: ${e.message}`
      : await unreachable(`Can't reach the bridge at ${S.ip}. Check that it's powered on and on the same network.`));
  } finally {
    refreshing = false;
    $('refreshBtn').classList.remove('spin');
  }
}

function mergeLights(data) {
  const now = Date.now();
  const groupBusy = queue.has('group/0') || inFlight.has('group/0');
  const next = {};
  for (const id of Object.keys(data)) {
    const fresh = data[id];
    const old = S.lights[id];
    const key = `light/${id}`;
    const busy = old && (groupBusy || queue.has(key) || inFlight.has(key) || now - (S.touched[id] || 0) < 3000);
    if (busy) {
      // Keep our newer values for what the user is changing right now.
      old.name = fresh.name;
      old.state.reachable = fresh.state.reachable;
      next[id] = old;
    } else {
      next[id] = fresh;
    }
  }
  S.lights = next;
  renderLights();
}

// ---------- light cards ----------

const cards = new Map(); // target key -> card element
let dragging = null;     // slider under the user's finger; code never moves it

function targets() {
  const ids = Object.keys(S.lights).sort((a, b) => Number(a) - Number(b));
  const list = ids.map((id) => ({ key: id, ids: [id], all: false }));
  if (ids.length > 1) list.unshift({ key: 'all', ids, all: true });
  return list;
}

function renderLights() {
  const list = targets();
  const keys = list.map((t) => t.key).join(',');
  const box = $('lights');
  if (box.dataset.keys !== keys) {
    box.textContent = '';
    cards.clear();
    for (const t of list) {
      const card = buildCard(t);
      cards.set(t.key, card);
      box.appendChild(card);
    }
    box.dataset.keys = keys;
  }
  $('emptyMsg').hidden = list.length > 0;
  syncCards();
}

function buildCard(target) {
  const card = $('cardTpl').content.firstElementChild.cloneNode(true);
  card.target = target;
  const q = (sel) => card.querySelector(sel);

  q('.power').addEventListener('change', (e) => apply(target, { on: e.target.checked }));
  q('.bri').addEventListener('input', (e) => apply(target, { bri: Number(e.target.value) }, true));
  q('.hue').addEventListener('input', (e) => apply(target, { hue: Number(e.target.value) }, true));
  q('.sat').addEventListener('input', (e) => apply(target, { sat: Number(e.target.value) }, true));
  q('.ct').addEventListener('input', (e) => apply(target, { ct: Number(e.target.value) }, true));

  const toggleFine = () => {
    if (S.expanded.has(target.key)) S.expanded.delete(target.key);
    else S.expanded.add(target.key);
    syncCard(card);
  };
  q('.swatch').addEventListener('click', toggleFine);
  q('.title').addEventListener('click', toggleFine);

  const presets = q('.presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.setAttribute('aria-label', p.label);
    b.style.background = hsv(p.deg, p.sat / 254, 1);
    b.addEventListener('click', () => apply(target, { hue: p.hue, sat: p.sat }));
    presets.appendChild(b);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'preset more';
  more.setAttribute('aria-label', 'Custom color');
  more.style.background = 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)';
  more.addEventListener('click', toggleFine);
  presets.appendChild(more);

  return card;
}

function summarize(target) {
  const ls = target.ids.map((id) => S.lights[id]).filter(Boolean);
  const on = ls.filter((l) => l.state.on);
  const pool = on.length ? on : ls;
  const colorLight = pool.find((l) => 'hue' in l.state) || ls.find((l) => 'hue' in l.state);
  const ctLight = pool.find((l) => 'ct' in l.state) || ls.find((l) => 'ct' in l.state);
  const bris = pool.filter((l) => 'bri' in l.state).map((l) => l.state.bri);
  return {
    lights: ls,
    onCount: on.length,
    reachable: ls.some((l) => l.state.reachable !== false),
    hasBri: ls.some((l) => 'bri' in l.state),
    hasColor: Boolean(colorLight),
    hasCt: Boolean(ctLight),
    bri: bris.length ? Math.round(bris.reduce((a, b) => a + b, 0) / bris.length) : 254,
    hue: colorLight ? colorLight.state.hue : 0,
    sat: colorLight ? colorLight.state.sat : 0,
    ct: ctLight ? ctLight.state.ct : 370,
    color: pool.length ? colorOf(pool[0].state) : '',
  };
}

function setSlider(el, value) {
  if (el !== dragging && el.value !== String(value)) el.value = value;
}

function syncCard(card) {
  const target = card.target;
  const s = summarize(target);
  if (!s.lights.length) return;
  const q = (sel) => card.querySelector(sel);
  const isOn = s.onCount > 0;

  card.classList.toggle('on', isOn);
  card.classList.toggle('unreachable', !s.reachable);
  q('.name').textContent = target.all ? 'All lights' : s.lights[0].name;
  let sub;
  if (!s.reachable) sub = 'Unreachable, check its power';
  else if (target.all) sub = `${s.onCount} of ${s.lights.length} on`;
  else if (!isOn) sub = 'Off';
  else sub = s.hasBri ? `On · ${Math.round((s.bri / 254) * 100)}%` : 'On';
  q('.sub').textContent = sub;
  q('.power').checked = isOn;
  q('.swatch').style.background = isOn ? s.color : '';
  card.style.setProperty('--glow', isOn ? s.color : 'transparent');

  const showColor = s.hasColor;
  const showCt = s.hasCt && !s.hasColor;
  q('.bri').hidden = !s.hasBri;
  q('.presets').hidden = !showColor;
  q('.fine').hidden = showColor ? !S.expanded.has(target.key) : !showCt;
  for (const sel of ['.hue', '.hue-label', '.sat', '.sat-label']) q(sel).hidden = !showColor;
  for (const sel of ['.ct', '.ct-label']) q(sel).hidden = !showCt;

  setSlider(q('.bri'), s.bri);
  setSlider(q('.hue'), s.hue);
  setSlider(q('.sat'), s.sat);
  setSlider(q('.ct'), s.ct);

  const deg = hueToDeg(s.hue);
  const full = showColor ? hsv(deg, s.sat / 254, 1) : ctColor(s.ct);
  q('.bri').style.setProperty('--track', `linear-gradient(to right, #000, ${full})`);
  q('.sat').style.setProperty('--track', `linear-gradient(to right, #fff, ${hsv(deg, 1, 1)})`);
  q('.ct').style.setProperty('--track', `linear-gradient(to right, ${ctColor(153)}, ${ctColor(500)})`);
}

function syncCards() {
  for (const card of cards.values()) syncCard(card);
}

// ---------- setup & pairing ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanIp(raw) {
  // Some locales' number pads only offer "," so accept 10,1,10,2 too.
  return raw.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/,/g, '.');
}

function devicetype() {
  let model = 'android';
  try {
    if (Native) model = Native.deviceName();
  } catch {
    // keep default
  }
  // v1 format is "<app>#<device>", 20 and 19 characters max.
  model = String(model).replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 19) || 'android';
  return `hue_remote#${model}`;
}

async function pair() {
  if (S.pairing) {
    S.pairing.cancelled = true;
    return;
  }
  const ip = cleanIp($('ipInput').value);
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(ip)) {
    setPairStatus('Enter the bridge IP address first.', 'error');
    return;
  }
  if (searchJob) searchJob.cancelled = true;
  const job = { cancelled: false };
  S.pairing = job;
  $('pairBtn').textContent = 'Cancel';
  $('searchBtn').disabled = true;
  const deadline = Date.now() + 30000;
  setPairStatus('Contacting the bridge…', 'waiting');
  try {
    while (!job.cancelled) {
      let reply;
      try {
        reply = await hue('POST', '/api', { devicetype: devicetype() }, ip);
      } catch (e) {
        setPairStatus(e instanceof NotHueError
          ? e.message
          : await unreachable(`No bridge answered at ${ip}. Check the address and that you're on the same network as the bridge.`), 'error');
        return;
      }
      if (job.cancelled) break;
      const ok = Array.isArray(reply) && reply.find((r) => r && r.success && r.success.username);
      if (ok) {
        await paired(ip, ok.success.username);
        return;
      }
      const err = firstError(reply);
      if (!err) {
        setPairStatus("That address answered, but it doesn't look like a Hue bridge.", 'error');
        return;
      }
      if (err.type !== 101) { // 101 = link button not pressed yet
        setPairStatus(`The bridge said: ${err.description}`, 'error');
        return;
      }
      const left = Math.ceil((deadline - Date.now()) / 1000);
      if (left <= 0) {
        setPairStatus('Timed out. Press the round button on the bridge, then tap Pair again.', 'error');
        return;
      }
      setPairStatus(`Press the round link button on top of the bridge now… ${left}s`, 'waiting');
      await sleep(1500);
    }
    setPairStatus('', '');
  } finally {
    S.pairing = null;
    $('pairBtn').textContent = 'Pair';
    $('searchBtn').disabled = false;
  }
}

async function paired(ip, user) {
  S.ip = ip;
  S.user = user;
  S.lights = {};
  S.touched = {};
  prefs.set('ip', ip);
  prefs.set('user', user);
  setPairStatus('', '');
  toast('Paired!');
  showView('lights');
  await refresh();
}

function unpaired() {
  S.user = '';
  S.lights = {};
  prefs.set('user', '');
  renderLights();
  showSetup("The bridge doesn't recognize this app anymore. Pair it again.");
}

// ---------- searching from a plain web page ----------
// A web page can't send SSDP, and browsers hide the device's own IP address. So the
// website searches the range you typed (e.g. "192.168.1"), or else finds your home
// network by checking which common home ranges have a router answering at .1 or .254,
// then asks every address in that range for /api/config. Only a Hue bridge answers
// that with Hue-shaped JSON (and the CORS header that lets the page read it).

const COMMON_SUBNETS = [
  '192.168.1', '192.168.0', '10.0.0', '192.168.2', '10.0.1', '192.168.4', '192.168.86',
  '192.168.50', '192.168.10', '192.168.100', '192.168.178', '192.168.68', '192.168.8',
  '192.168.3', '192.168.5', '192.168.11', '192.168.15', '192.168.31', '192.168.88',
  '192.168.20', '192.168.123', '10.1.10', '10.0.2', '10.10.10', '172.16.0',
];

/** "a.b.c" from something like "192.168.1", "192.168.1.x" or a full IP, if it's a LAN range. */
function subnetOf(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.(?:\d{1,3}|x|\*))?$/i.exec(cleanIp(text));
  if (!m) return null;
  const prefix = `${m[1]}.${m[2]}.${m[3]}`;
  return isPrivateIPv4(`${prefix}.1`) ? prefix : null;
}

/** Run fn over items, `limit` at a time, until done or the job is cancelled. */
async function eachLimit(items, limit, job, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !job.cancelled) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** 'answered' (something served HTTP), 'refused' (failed right away) or 'silent'. */
async function probe(ip) {
  const started = Date.now();
  try {
    await localFetch(`http://${ip}/`, { mode: 'no-cors' }, 1500);
    return 'answered';
  } catch {
    return Date.now() - started < 700 ? 'refused' : 'silent';
  }
}

/** Which of these ranges look like the network we're on, most likely first. */
async function liveSubnets(subnets, job) {
  const seen = {};
  const ips = subnets.flatMap((s) => [`${s}.1`, `${s}.254`]);
  await eachLimit(ips, 32, job, async (ip) => {
    seen[ip] = await probe(ip);
  });
  const has = (s, result) => seen[`${s}.1`] === result || seen[`${s}.254`] === result;
  // A home usually has one network, two with an ISP router in front of your own.
  const answered = subnets.filter((s) => has(s, 'answered')).slice(0, 4);
  if (answered.length) return answered;
  // Some routers have no web page and just refuse the connection. If only a few ranges
  // refused, that's probably it; if most did, something is rejecting everything, and
  // sweeping them all would take minutes, so leave it to a typed range.
  const refused = subnets.filter((s) => has(s, 'refused'));
  return refused.length <= 3 ? refused : [];
}

/** { ip, name } if a Hue bridge answers at this address. */
async function identifyBridge(ip) {
  try {
    const res = await localFetch(`http://${ip}/api/config`, {}, 1500);
    const data = await res.json();
    const hueShaped = Array.isArray(data)
      ? data.some((r) => r && r.error && r.error.type === 1) // "unauthorized user": older firmware
      : Boolean(data && (data.bridgeid || data.swversion || data.apiversion));
    if (hueShaped) return { ip, name: (!Array.isArray(data) && data.name) || '' };
  } catch {
    // nothing there, not HTTP, or not something the page may read
  }
  return null;
}

async function scanSubnet(subnet, job, progress) {
  const found = [];
  let done = 0;
  const ips = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
  // Stop handing out addresses once a bridge turns up; the ones in flight still finish.
  const until = { get cancelled() { return job.cancelled || found.length > 0; } };
  await eachLimit(ips, 64, until, async (ip) => {
    const bridge = await identifyBridge(ip);
    if (bridge) found.push(bridge);
    if (++done % 8 === 0) progress(`Checking ${subnet}.1 to ${subnet}.254… ${Math.round((done / ips.length) * 100)}%`);
  });
  return found.sort((a, b) => Number(a.ip.split('.')[3]) - Number(b.ip.split('.')[3]));
}

async function scanOnce(job, say) {
  const typed = subnetOf($('ipInput').value);
  if (typed) {
    const found = await scanSubnet(typed, job, say);
    if (found.length || job.cancelled) return { bridges: found };
  }
  say('Looking for your home network…');
  const live = await liveSubnets(COMMON_SUBNETS.filter((s) => s !== typed), job);
  for (const subnet of live) {
    if (job.cancelled) break;
    const found = await scanSubnet(subnet, job, say);
    if (found.length) return { bridges: found };
  }
  return { bridges: [] };
}

async function scanFromBrowser(job, progress) {
  const permission = await localNetworkPermission();
  if (permission && permission.state === 'denied') return { bridges: [], blocked: true };
  const asking = Boolean(permission && permission.state === 'prompt');
  const say = (msg) => progress(permission && permission.state === 'prompt'
    ? `${msg} If your browser asks to let this site access devices on your local network, choose Allow.`
    : msg);
  let result = await scanOnce(job, say);
  // The first pass may have run while the browser was still asking. Once allowed, go again.
  if (asking && !result.bridges.length && !job.cancelled && permission.state === 'granted') {
    result = await scanOnce(job, say);
  }
  if (permission && permission.state === 'denied') return { bridges: [], blocked: true };
  return Object.assign(result, { permission });
}

let searchJob = null;

async function search() {
  if (searchJob) {
    searchJob.cancelled = true; // the website's search can be stopped
    return;
  }
  const job = { cancelled: false };
  searchJob = job;
  const btn = $('searchBtn');
  btn.textContent = BROWSER ? 'Stop' : 'Searching…';
  btn.disabled = !BROWSER;
  $('found').textContent = '';
  setPairStatus('Looking for bridges on this network…', 'waiting');
  try {
    let bridges = [];
    if (Native) {
      const r = await callNative('discover');
      if (r.ok) bridges = r.bridges.map((ip) => ({ ip, name: '' }));
    } else {
      const result = await scanFromBrowser(job, (msg) => setPairStatus(msg, 'waiting'));
      if (job.cancelled) {
        setPairStatus('', '');
        return;
      }
      if (result.blocked) {
        setPairStatus(await unreachable("The browser didn't let this site search your local network."), 'error');
        return;
      }
      bridges = result.bridges;
      const permission = result.permission;
      if (!bridges.length && permission && permission.state === 'prompt') {
        // Still waiting on the browser's prompt: search again as soon as it's allowed.
        permission.onchange = () => {
          permission.onchange = null;
          if (permission.state === 'granted' && S.view === 'setup' && !searchJob) search();
        };
      }
    }
    if (!bridges.length) {
      setPairStatus(BROWSER
        ? await unreachable("No bridge found. Type its IP address instead: your router's list of connected devices shows it. Or type the first three parts of this device's own IP address (in its Wi-Fi settings), like 192.168.1, and search again.")
        : "No bridge found automatically. Type its IP address instead (your router's device list shows it).", 'error');
      return;
    }
    setPairStatus(bridges.length === 1 ? 'Found your bridge. Tap Pair.' : 'Pick your bridge, then tap Pair.', '');
    if (bridges.length === 1) $('ipInput').value = bridges[0].ip;
    for (const bridge of bridges) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = bridge.name ? `${bridge.ip} · ${bridge.name}` : bridge.ip;
      chip.addEventListener('click', () => {
        $('ipInput').value = bridge.ip;
      });
      $('found').appendChild(chip);
    }
  } finally {
    searchJob = null;
    btn.disabled = Boolean(S.pairing);
    btn.textContent = 'Search network';
  }
}

// ---------- screens, sheet, messages ----------

function showView(name) {
  S.view = name;
  $('setupView').hidden = name !== 'setup';
  $('lightsView').hidden = name !== 'lights';
  $('barActions').hidden = name !== 'lights';
}

function showSetup(message, returnable = false) {
  S.returnToLights = returnable;
  $('ipInput').value = S.ip;
  $('found').textContent = '';
  $('cancelSetupBtn').hidden = !returnable;
  setPairStatus(message, message ? 'error' : '');
  showView('setup');
}

function leaveSetup() {
  if (S.pairing) S.pairing.cancelled = true;
  setPairStatus('', '');
  showView('lights');
}

async function openSheet() {
  $('sheet').hidden = false;
  fillInfo([['IP address', S.ip]]);
  try {
    const c = await hue('GET', `/api/${S.user}/config`);
    if (firstError(c)) return;
    fillInfo([
      ['Name', c.name],
      ['IP address', S.ip],
      ['Model', c.modelid],
      ['Software', c.swversion],
      ['API version', c.apiversion],
      ['Zigbee channel', c.zigbeechannel],
    ]);
  } catch {
    // leave the basic info up
  }
}

function fillInfo(rows) {
  const dl = $('bridgeInfo');
  dl.textContent = '';
  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === '') continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    dl.append(dt, dd);
  }
}

function closeSheet() {
  $('sheet').hidden = true;
}

function forget() {
  if (!confirm("Forget this bridge? You'll need to press its link button to pair again.")) return;
  closeSheet();
  S.user = '';
  S.lights = {};
  prefs.set('user', '');
  renderLights();
  showSetup('');
}

function setBanner(msg) {
  $('banner').hidden = !msg;
  $('bannerText').textContent = msg;
}

function setPairStatus(msg, kind) {
  const el = $('pairStatus');
  el.hidden = !msg;
  el.textContent = msg;
  el.className = `notice ${kind || ''}`;
}

let toastTimer = 0;
let lastToast = '';
let lastToastAt = 0;

function toast(msg) {
  if (msg === lastToast && Date.now() - lastToastAt < 3000) return;
  lastToast = msg;
  lastToastAt = Date.now();
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3000);
}

/** Called by MainActivity on the Android back button; true = handled here. */
window.handleBack = () => {
  if (!$('sheet').hidden) {
    closeSheet();
    return true;
  }
  if (S.view === 'setup' && S.returnToLights && S.user) {
    leaveSetup();
    return true;
  }
  return false;
};

// ---------- start ----------

function boot() {
  document.documentElement.style.setProperty('--hue-track', hueTrack());

  if (BROWSER) $('browserNote').hidden = false;
  $('pairBtn').addEventListener('click', pair);
  $('searchBtn').addEventListener('click', search);
  $('ipInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pair();
  });
  $('cancelSetupBtn').addEventListener('click', leaveSetup);
  $('refreshBtn').addEventListener('click', refresh);
  $('retryBtn').addEventListener('click', refresh);
  $('settingsBtn').addEventListener('click', openSheet);
  $('closeSheetBtn').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => {
    if (e.target === $('sheet')) closeSheet();
  });
  $('repairBtn').addEventListener('click', () => {
    closeSheet();
    showSetup('', true);
  });
  $('forgetBtn').addEventListener('click', forget);
  const all = () => ({ all: true, ids: Object.keys(S.lights) });
  $('allOnBtn').addEventListener('click', () => apply(all(), { on: true }));
  $('allOffBtn').addEventListener('click', () => apply(all(), { on: false }));

  document.addEventListener('pointerdown', (e) => {
    if (e.target.classList && e.target.classList.contains('slider')) dragging = e.target;
  });
  const endDrag = () => {
    dragging = null;
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // Pick up changes made elsewhere (wall switch, another app).
  setInterval(() => {
    if (S.view === 'lights' && !document.hidden) refresh();
  }, 10000);
  document.addEventListener('visibilitychange', () => {
    if (S.view === 'lights' && !document.hidden) refresh();
  });

  S.ip = prefs.get('ip');
  S.user = prefs.get('user');
  if (S.ip && S.user) {
    showView('lights');
    refresh();
  } else {
    showSetup('');
  }
}

boot();
