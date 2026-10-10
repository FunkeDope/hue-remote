# Hue Remote

A small remote for Philips Hue lights. Pair it with your bridge once, then switch
lights on and off, dim them and set colors from an Android phone or a web browser.

No account, no cloud, no tracking. It only talks to the bridge on your own network,
over the bridge's local v1 API.

**Use it in your browser:** <https://funkedope.github.io/hue-remote/> (Chrome or Edge).
**Download:** the Android APK and the Node.js web version are on the
[releases page](https://github.com/FunkeDope/hue-remote/releases). Changes are in
[RELEASE_NOTES.md](RELEASE_NOTES.md).

<p>
  <img src="docs/screenshots/lights.png" width="220" alt="Lights screen">
  <img src="docs/screenshots/custom-color.png" width="220" alt="Hue and saturation sliders">
  <img src="docs/screenshots/pairing.png" width="220" alt="Pairing screen">
</p>

## Supported bridges

The app uses only the local v1 (CLIP) API over plain HTTP. It doesn't check the bridge
model, so any bridge that serves that API should work. This is what I can actually say:

| Bridge | Model | Status |
|---|---|---|
| Hue bridge v1 (round, 2012) | `BSB001`, firmware `01043155`, API `1.16.0` | **Tested.** This is the bridge it was built on. |
| Hue bridge v2 (square, 2015) | `BSB002` | **Untested.** It serves the same local v1 API, so pairing and light control should work. The browser version also needs the bridge to send `Access-Control-Allow-Origin: *`, which I haven't been able to check on a v2. |
| Hue Bridge Pro (2025) | | **Untested.** I don't know whether it still serves the v1 API. |

I only own a v1 bridge. If you try another one, please open an issue saying what happened.

**Lights:** color lights (Bloom, Iris, LivingColors, color bulbs), white-ambiance bulbs,
dimmable white bulbs and smart plugs. Tested with two Living Colors Bloom (`LLC011`).

## What you get

- Pairing by **Search network** or by typing the bridge's IP, then pressing the link button.
- Per light: power switch, brightness, 10 color presets, and hue/saturation sliders.
- An **All lights** card plus **All on** / **All off** buttons.
- Color-temperature slider on white-ambiance bulbs; brightness only on dimmable bulbs;
  just the switch on plugs.
- Unreachable lights are flagged. Changes made elsewhere show up within 10 seconds.
- Light management, like the old official app: add new lights (search, by serial number,
  or Touchlink), rename them, blink one to find it, and remove one from the bridge.
- A gear button with bridge details, rename the bridge, pair a different one or forget it.

## Three ways to run it

All three run the same HTML/JS from [`web/`](web).

### 1. Website (nothing to install)

Open <https://funkedope.github.io/hue-remote/> in **Chrome or Edge 142+** on a computer
or Android phone on the same network as the bridge.

1. Click **Search network** and **Allow** when the browser asks for local network access.
   If nothing is found, type the bridge's IP (or just the first three parts, like
   `192.168.1`, and search again).
2. Click **Pair**, then press the button on the bridge within 30 seconds.

The pairing is saved in that browser. The page is static files on GitHub Pages; your
browser talks to the bridge directly. Safari can't do this, and Firefox is unconfirmed.

### 2. Android app

Android 5.0 or newer.

1. Download `hue-remote-<version>.apk` from the
   [latest release](https://github.com/FunkeDope/hue-remote/releases/latest) and open it.
   Allow installs from your browser if asked; if Play Protect warns, tap
   **More details → Install anyway**.
2. On the same Wi-Fi as the bridge, tap **Search network** or type the IP, tap **Pair**,
   and press the button on the bridge.

If an update says **App not installed**, the APK was signed with a different key:
uninstall the old one first and pair again.

### 3. Web version (Node.js)

Node.js 18 or newer. No npm dependencies.

```sh
npm start                     # http://localhost:8080/
npm start -- --port 9000      # another port
npm start -- --lan            # also serve to phones and tablets on your network
```

| Setting | Flag | Environment variable |
|---|---|---|
| Port | `--port 9000` | `PORT=9000` |
| Serve to the whole network | `--lan` | `HUE_LAN=1` |
| Config file location | | `HUE_CONFIG=C:\path\to\config.json` (default `server\config.json`) |
| Extra host names to answer to | | `HUE_ALLOWED_HOSTS=hue.home,lights.lan` |

PowerShell: `$env:PORT = 9000; npm start`.

The pairing is stored on the server, so every browser that opens the page is paired.
With `--lan`, anyone on your network who can open the page can control your lights.

## Managing lights

- **Pencil on a light's card:** rename it, **Blink to find it**, or **Remove from bridge**.
- **Gear → Add lights:** switch the new lights on and tap **Search for new lights**. The
  bridge searches for about a minute and new lights appear as they're found.
  - A light that was paired to another bridge won't show up in a plain search. Type its
    serial number (the 6 characters printed on the bulb) first, or hold it within a few
    feet of the bridge and tap **Touchlink**. Touchlink needs bridge firmware that
    supports it; the app says so if yours doesn't.
- **Gear → Bridge name:** rename the bridge (4 to 16 characters).

## Finding your bridge's IP

- **Search network** in any of the three versions.
- Your router's device list. The bridge shows up as `Philips-hue`, MAC starting `00:17:88`.
- Windows: `arp -a | findstr 00-17-88`.

## How it works

```
Android:  web/ in a WebView ──window.Native──▶ MainActivity.java ──HTTP──▶ bridge
Node:     web/ + shim.js    ──POST /native/*─▶ server/server.js  ──HTTP──▶ bridge
Website:  web/ on GitHub Pages ──fetch()──────────────────────────────────▶ bridge
```

Hue v1 API calls used: `POST /api` to pair, `GET /api/<user>/lights`,
`PUT /api/<user>/lights/<id>/state`, `PUT /api/<user>/groups/0/action` for all lights,
`GET /api/<user>/config` for bridge details, and for management `POST /api/<user>/lights`
plus `GET /api/<user>/lights/new` (search), `PUT /api/<user>/lights/<id>` (rename),
`DELETE /api/<user>/lights/<id>` and `PUT /api/<user>/config` (bridge name, touchlink). Discovery is SSDP plus a scan of the
local /24 for `/description.xml` (app and Node), or a scan of common home ranges for
`/api/config` (website). Slider changes are merged per light and sent at most every 100 ms.

**Privacy and security:** the only thing stored is the bridge's IP and the username it
issued at pairing (app storage, browser localStorage, or `server/config.json`). Nothing
goes to the internet. The Node server listens on `127.0.0.1` unless started with
`--lan`, only forwards to `/api` on private IPs, only answers under this computer's own
names (no DNS rebinding) and only accepts same-origin requests on `/native/*`.
**Forget this bridge** clears the pairing locally; the bridge keeps the entry in its
whitelist until you `DELETE /api/<user>/config/whitelist/<user>`.

## Development

```sh
npm test        # server tests against the fake bridge
npm run mock    # fake v1 bridge on port 8123 with two lights (link button "pressed" on the 3rd try;
                # a search for new lights finds one after a few seconds)
npm run site    # builds the website into site/
android/build.sh   # builds the APK on Ubuntu/WSL, no Gradle (see the script for the apt packages)
```

**Release:** bump the version in `package.json` and `android/AndroidManifest.xml`
(`versionName`, `versionCode` +1), add a `## <version> (<date>)` section to
`RELEASE_NOTES.md`, push to `main`. [`release.yml`](.github/workflows/release.yml)
builds the APK and web zip and publishes the release. To make APK updates install in
place, store a signing key in the `HUE_REMOTE_KEYSTORE` (base64) and
`HUE_REMOTE_KEYSTORE_PASSWORD` repository secrets. The website is published by
[`pages.yml`](.github/workflows/pages.yml) on every push to `main` that changes `web/`.

```
android/   AndroidManifest.xml, MainActivity.java (WebView host), res/, build.sh
web/       the UI shared by all three versions
server/    server.js (web version), shim.js (window.Native for the browser)
dev/       mock-bridge.js
scripts/   build-site.js
test/      server.test.js
```

## Troubleshooting

- **Website says "No bridge answered":** use Chrome/Edge 142+. If you blocked the local
  network prompt, click the icon left of the address bar, set **Local network access**
  to **Allow**, reload. Also check the bridge sends CORS headers:
  `(Invoke-WebRequest http://<bridge-ip>/api/config -UseBasicParsing).Headers['Access-Control-Allow-Origin']`
  should print `*`. If not, use the app or the Node version.
- **"No bridge answered at …":** wrong IP, or you're on a different network (guest
  Wi-Fi). Give the bridge a DHCP reservation so its IP stops changing.
- **Search finds nothing:** some routers block discovery, and the Windows firewall can
  block replies. Type the IP instead.
- **Pairing times out:** press the bridge button within the 30-second countdown.
- **A light is "Unreachable":** it's off at the wall or out of Zigbee range.
- **"The bridge doesn't recognize this app anymore":** the bridge was reset. Pair again.
- **"Port 8080 is already in use":** `npm start -- --port 8081`.
