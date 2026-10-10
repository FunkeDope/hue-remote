// Gives web/app.js the same window.Native object the Android app provides,
// backed by server.js. server.js injects window.__HUE_BOOT__ (saved settings)
// into the page before this script runs.
(function () {
  'use strict';

  const boot = window.__HUE_BOOT__ || { prefs: {}, deviceName: 'browser' };
  const prefs = Object.assign({}, boot.prefs);

  function post(path, data) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then((res) => res.json());
  }

  // Answer through window.__nativeCb, exactly like MainActivity.deliver().
  function call(id, path, data) {
    post(path, data)
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
      .then((result) => {
        result.id = id;
        window.__nativeCb(result);
      });
  }

  window.Native = {
    http(id, method, url, body) {
      call(id, '/native/http', { method, url, body });
    },
    discover(id) {
      call(id, '/native/discover', {});
    },
    getPref(key) {
      return prefs[key] || '';
    },
    setPref(key, value) {
      prefs[key] = value;
      post('/native/pref', { key, value: value || '' }).catch(() => {});
    },
    deviceName() {
      return boot.deviceName;
    },
  };
})();
