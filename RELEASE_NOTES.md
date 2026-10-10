# Release notes

## 1.0.0 (2026-10-10)

First release of Hue Remote, a no-nonsense remote for the original round Philips Hue
bridge (v1, model BSB001). It pairs with the bridge and controls your lights over your
own network. There's no account, no cloud, no ads and no tracking.

It comes in two flavors that share the same interface:

- **Android app**: `hue-remote-1.0.0.apk`, about 36 KB, Android 5.0 or newer.
- **Web version**: `hue-remote-web-1.0.0.zip`, a small Node.js server you run on a
  computer and open in Chrome (or any modern browser). It needs Node 18+ and nothing
  from npm.

### Pairing

- Type the bridge's IP address, or tap **Search network** to find it. Search uses
  SSDP first, then scans the local subnet if nothing answers.
- Press the round link button on the bridge. The app keeps trying for 30 seconds and
  shows a countdown.
- The pairing is saved, so the app opens straight to your lights from then on.
- If the bridge stops recognizing the app (for example after a factory reset), the app
  takes you back to pairing instead of failing silently.

### Lights

- A power switch, brightness slider and 10 color presets on every light.
- Hue and saturation sliders for picking any color, under the rainbow button.
- An **All lights** card that sets every light at once, plus **All on** and
  **All off** buttons that switch them together.
- White-ambiance bulbs get a color-temperature slider. Dimmable-only bulbs get just
  brightness, and plugs get just the switch.
- Lights the bridge can't reach (switched off at the wall, out of range) are dimmed
  and marked "Unreachable".
- Changes made elsewhere (another app, a dimmer switch) show up within 10 seconds,
  or right away with the refresh button.
- Slider drags are throttled to about 10 commands a second, so the bridge never gets
  flooded.

### Bridge settings

- The gear button shows the bridge's name, IP, model, firmware, API version and
  Zigbee channel.
- From there you can pair a different bridge or forget this one.

### Web version

- `npm start`, then open <http://localhost:8080/>.
- `--lan` makes it reachable from phones and tablets on your network too.
- The pairing is stored on the server (`server/config.json`), so every browser that
  opens the page is already paired.
- The server only forwards requests to the bridge API at a private (LAN) IP address,
  only answers under this computer's own names, and rejects requests from other
  websites.

### Tested with

- Android app: a real BSB001 bridge (firmware 01043155, API 1.16.0) with two Hue
  Living Colors Bloom lamps (LLC011).
- Web version: automated tests against a simulated v1 bridge in headless Chrome. It
  hasn't been run against a real bridge yet.

### Known limitations

- Controls lights only. There are no rooms, scenes, schedules, sensors, or renaming.
- Works on your local network only. Remote access isn't supported, by design.
- **Forget this bridge** clears the pairing in the app but leaves the app's entry in
  the bridge's list of authorized apps.
- On Windows, the firewall may block replies to **Search network**. The subnet scan
  usually still finds the bridge, or you can type its IP.

### Installing over an earlier build

This release's APK is signed with a different key than the test build shared before
it (from the `ccr-967645b9-6z0l1r` branch). Android won't install one over the
other, so uninstall the old one first. You'll just need to pair again.
