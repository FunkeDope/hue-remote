# Hue Remote

A no-nonsense remote for the original round Philips Hue bridge (v1, model `BSB001`).
Pair it once, then switch your lights on and off and set their colors from an Android
phone or any web browser.

There's no account, no cloud, no ads and no tracking. It only talks to the bridge on
your own network, using the bridge's local v1 API (the only API the v1 bridge has).

<p>
  <img src="docs/screenshots/lights.png" width="220" alt="Lights screen with All lights, Left and Right cards">
  <img src="docs/screenshots/custom-color.png" width="220" alt="Hue and saturation sliders opened on a light">
  <img src="docs/screenshots/pairing.png" width="220" alt="Pairing screen asking to press the link button">
</p>
<p>
  <img src="docs/screenshots/desktop.png" width="672" alt="The web version in a desktop browser">
</p>

**Download:** the APK and the web version are attached to each
[release](https://github.com/FunkeDope/skiddie.life/releases). What changed in each
version is in [RELEASE_NOTES.md](RELEASE_NOTES.md).

## Contents

- [Features](#features)
- [What it works with](#what-it-works-with)
- [Android app](#android-app)
- [Web version (Node.js)](#web-version-nodejs)
- [Using it](#using-it)
- [How it works](#how-it-works)
- [Privacy and security](#privacy-and-security)
- [Building from source](#building-from-source)
- [Releasing a new version](#releasing-a-new-version)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

## Features

- **Pairing:** type the bridge's IP or let it search the network, then press the
  bridge's link button.
- **Per light:** a power switch, brightness, 10 color presets, and hue and saturation
  sliders for any other color.
- **All lights at once:** an "All lights" card, plus All on and All off buttons.
- **White and dimmable bulbs:** a color-temperature slider for white-ambiance bulbs,
  brightness only for dimmable bulbs, and just the switch for plugs.
- **Status:** unreachable lights are flagged, and changes made elsewhere show up
  within 10 seconds.
- **Bridge info:** name, model, firmware, API version and Zigbee channel. You can also
  pair a different bridge or forget this one.
- **Two versions, one UI:** the Android app and the web version run the same HTML/JS.
- **Tiny:** the APK is about 36 KB, and the web version has no npm dependencies.

## What it works with

| | |
|---|---|
| **Bridge** | Hue bridge v1 (round, `BSB001`) on its final firmware, `01043155` / API `1.16.0`. The v2 (square) bridge still serves the same local v1 API, so it should work too, but that hasn't been tested. |
| **Lights** | Color lights (Bloom, Iris, LivingColors, color bulbs), white-ambiance bulbs, dimmable white bulbs and smart plugs. Tested with Hue Living Colors Bloom (`LLC011`). |
| **Android** | 5.0 (Lollipop) or newer. |
| **Web version** | Node.js 18 or newer on Windows, macOS or Linux, and any current browser (built and tested with Chrome). |

## Android app

### Install

1. On the phone, open the [latest release](https://github.com/FunkeDope/skiddie.life/releases/latest)
   and download `hue-remote-<version>.apk`.
2. Open the downloaded file. Android will ask you to allow installs from your browser
   or Files app. Allow it.
3. Play Protect may warn that it doesn't recognize the developer. Tap
   **More details → Install anyway**.

If the phone won't sideload at all, install it from a computer instead:
`adb install hue-remote-<version>.apk`.

### Pair

1. Connect the phone to the same Wi-Fi as the bridge and open **Hue Remote**.
2. Type the bridge's IP address (your router's device list shows it), or tap
   **Search network**.
3. Tap **Pair**, then press the round button on top of the bridge within 30 seconds.

The pairing is saved, so from then on the app opens straight to your lights.

### Updating

A new APK installs over the old one only if both were signed with the same key. If
Android says **App not installed**, uninstall the old version first. You'll just need
to pair again. (See [Signing key](#signing-key) to keep releases updatable in place.)

## Web version (Node.js)

The web version is a small Node.js server. It serves the same UI as the Android app and
relays its requests to the bridge, so it works in any browser without CORS or
mixed-content problems.

### Run it

1. Install [Node.js](https://nodejs.org/) 18 or newer.
2. Download `hue-remote-web-<version>.zip` from the
   [latest release](https://github.com/FunkeDope/skiddie.life/releases/latest) and
   unzip it (or clone the `hue-control` branch).
3. In a terminal in that folder, run:

   ```sh
   npm start
   ```

4. Open <http://localhost:8080/> in Chrome and pair the same way as on Android.

There's nothing to `npm install`. To stop it, press **Ctrl+C**.

### Options

```sh
npm start -- --port 9000     # use a different port (default 8080)
npm start -- --lan           # also let phones and tablets on your network open it
node server/server.js --help
```

| Setting | Flag | Environment variable |
|---|---|---|
| Port | `--port 9000` | `PORT=9000` |
| Serve to the whole network | `--lan` | `HUE_LAN=1` |
| Where settings are saved | | `HUE_CONFIG=C:\path\to\config.json` (default `server\config.json`) |
| Extra host names to answer to | | `HUE_ALLOWED_HOSTS=hue.home,lights.lan` |

PowerShell sets environment variables like this: `$env:PORT = 9000; npm start`.

### Using it from other devices

Start it with `npm start -- --lan`. The terminal prints the addresses to use, for
example `http://192.168.1.50:8080/`. Open one on your phone. Windows may ask whether
to let Node.js through the firewall. Allow it on **private** networks.

The pairing is stored on the server, so every browser that opens the page is already
paired. That also means anyone on your network who can open the page can control your
lights.

## Using it

- **Power switch:** turns that light on or off.
- **Brightness slider:** dims the light, and turns it on if it was off.
- **Color dots:** warm white, white, red, orange, yellow, green, cyan, blue, purple
  and pink.
- **Rainbow dot** (or tapping the light's name): opens hue and saturation sliders for
  any other color.
- **All lights card:** shown when you have two or more lights. Anything you set there
  applies to every light.
- **All on / All off:** switch every light together.
- **Refresh button:** reloads the lights now. They also refresh every 10 seconds and
  whenever you come back to the app.
- **Gear button:** shows bridge details and lets you pair a different bridge or forget
  this one.

## How it works

The UI in [`web/`](web) is plain HTML, CSS and JavaScript. It does everything through a
small `window.Native` object, which each version provides:

```
Android:  web/ in a WebView ──window.Native──▶ MainActivity.java ──HTTP──▶ bridge
Browser:  web/ + shim.js    ──POST /native/*─▶ server/server.js  ──HTTP──▶ bridge
```

`window.Native` has five methods: `http` (send a request to the bridge), `discover`
(find bridges), `getPref` and `setPref` (saved settings), and `deviceName`. Going
through it sidesteps CORS and Android's cleartext rules, and lets discovery use UDP,
which a web page can't.

The Hue v1 API calls it makes:

| What | Request |
|---|---|
| Pair | `POST /api` with `{"devicetype":"hue_remote#<device>"}`. It returns error 101 until the link button is pressed, then a username. |
| List lights | `GET /api/<username>/lights` |
| Change a light | `PUT /api/<username>/lights/<id>/state` with `on`, `bri`, `hue`, `sat`, `ct`, `transitiontime` |
| All on / off | `PUT /api/<username>/groups/0/action` (group 0 is every light) |
| Bridge details | `GET /api/<username>/config` |
| Find bridges | SSDP `M-SEARCH` to `239.255.255.250:1900`, then `GET /description.xml` on each address in the local /24 |

Slider drags fire far faster than the bridge can keep up with (about 10 commands a
second). So changes are merged per light, sent round-robin at most every 100 ms, and
never sent twice at once for the same light.

## Privacy and security

- **What's stored:** the bridge's IP address and the username it issued at pairing. On
  Android that's in the app's private storage. In the web version it's
  `server/config.json`.
- **Network traffic:** only to the bridge. Search sends one SSDP multicast and, if
  nothing answers, requests `/description.xml` from each address on your subnet.
  Nothing goes to the internet.
- **Web server:**
  - Listens on `127.0.0.1` only, unless you start it with `--lan`.
  - Only forwards requests to `/api` on a private (LAN) IP address. With `--lan`, it
    won't forward to this computer itself (localhost or its own LAN addresses).
  - Only answers when addressed as `localhost`, an IP address, or this computer's own
    name. That blocks DNS-rebinding tricks.
  - Its `/native/*` endpoints accept same-origin JSON requests only, so other websites
    open in your browser can't call them.
- **Forget this bridge** clears the pairing in the app. The bridge keeps the app's
  entry in its list of authorized apps (its whitelist) until you remove it with the v1
  API: `DELETE /api/<username>/config/whitelist/<username>`.

## Building from source

### Android

The APK is built with the Android tools Debian and Ubuntu package, with no Gradle or
Android Studio. On Ubuntu or WSL:

```sh
sudo apt install openjdk-21-jdk-headless zip android-sdk-platform-23 aapt dalvik-exchange zipalign apksigner
android/build.sh      # writes android/build/hue-remote.apk
```

The script compiles the resources (`aapt2`), the Java (`javac --release 8`) and the dex
(`dx`). It packages `web/` as the app's assets, then aligns and signs the APK. It signs
with `~/.android/debug.keystore`, creating it if needed, unless you set `KEYSTORE`,
`KEYSTORE_PASS` and `KEY_ALIAS`.

### Web version

There's nothing to build. `npm start` runs it straight from the source.

### Tests and the fake bridge

```sh
npm test       # server tests, run against the fake bridge
npm run mock   # a fake v1 bridge on port 8123, with two lights
```

To work on the UI without the real bridge, run `npm run mock` and `npm start` in two
terminals. Then open <http://localhost:8080/> and pair with `localhost:8123`. The fake
link button counts as pressed on the third try.

## Releasing a new version

1. Bump the version in `package.json` and in `android/AndroidManifest.xml`
   (`versionName`, and `versionCode` +1). The two have to match.
2. Add a `## <version> (<date>)` section at the top of `RELEASE_NOTES.md`.
3. Commit and push to `hue-control`.

On every push to `hue-control`,
[`.github/workflows/release.yml`](.github/workflows/release.yml) checks whether that
version has a release yet. If not, it runs the tests, builds the APK and the web zip,
creates the `hue-remote-v<version>` tag, and publishes a GitHub release with that
version's notes and SHA-256 checksums. Pushes that don't change the version do
nothing. Pushing a `hue-remote-v*` tag yourself also triggers a release.

### Signing key

Without a signing key set up, each release's APK is signed with a new throwaway key,
so installing it means uninstalling the previous one first. To make updates install in
place, create a key once and store it as repository secrets:

```sh
keytool -genkeypair -keystore hue-remote.keystore -alias hue-remote \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Hue Remote"
base64 -w0 hue-remote.keystore    # PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("hue-remote.keystore"))
```

Then, in the repo, go to **Settings → Secrets and variables → Actions** and add two
secrets:

- `HUE_REMOTE_KEYSTORE`: the base64 text.
- `HUE_REMOTE_KEYSTORE_PASSWORD`: the password you chose.

Keep the keystore file somewhere safe. If you lose it, you can't publish updates that
install over the old version.

## Project layout

```
android/
  AndroidManifest.xml
  src/life/skiddie/hueremote/MainActivity.java   WebView host: HTTP, discovery, settings
  res/                                           app name, theme, launcher icon
  build.sh                                       builds the APK (no Gradle)
web/                                             the UI, shared by both versions
  index.html  style.css  app.js  icon.svg
server/
  server.js                                      web version: serves web/, relays to the bridge
  shim.js                                        window.Native for the browser
dev/mock-bridge.js                               fake v1 bridge for development and tests
test/server.test.js                              npm test
docs/screenshots/
.github/workflows/release.yml                    builds and publishes releases from tags
RELEASE_NOTES.md
```

## Troubleshooting

### "No bridge answered at …"
Check the IP address, and that the phone or computer is on the same network as the
bridge (not a guest network). If the bridge's IP keeps changing, give it a fixed
address (a DHCP reservation) in your router.

### Search network finds nothing
Some routers block device discovery between Wi-Fi clients, and on Windows the
firewall can block the replies. Type the IP address instead.

### Pairing times out
Press the round button on the bridge after tapping **Pair**. It has to happen within
the 30-second countdown.

### A light says "Unreachable"
The bridge can't reach it over Zigbee. Usually it's switched off at the wall, or too
far from the bridge and the other lights.

### "The bridge doesn't recognize this app anymore"
The bridge was reset or the app was removed from its whitelist. Pair again.

### Android says "App not installed"
The installed copy was signed with a different key. Uninstall it, then install the
new APK.

### "Port 8080 is already in use"
Something else is using that port. Run `npm start -- --port 8081`.
