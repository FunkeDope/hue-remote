# Release notes

## Unreleased

- **Light management**, matching what the old official app's settings could do:
  - **Add lights** from the bridge sheet: search for new lights, add by serial number,
    or Touchlink the closest light. New lights show up as the search finds them.
  - A pencil on each light's card to **rename** it, **blink** it to find it, or
    **remove** it from the bridge.
  - **Rename the bridge.**
- The fake bridge (`npm run mock`) fakes all of that too, and `npm test` covers it.

## 1.0.0 (2026-10-10)

First release. Pairs with a Hue bridge over its local v1 API and controls your lights on
your own network. No account, no cloud, no tracking.

- **Android app** (`hue-remote-1.0.0.apk`, about 36 KB, Android 5.0+) and a
  **Node.js web version** (`hue-remote-web-1.0.0.zip`, Node 18+, no npm dependencies).
  Same UI in both.
- **Pairing:** type the bridge's IP or tap **Search network** (SSDP, then a subnet scan),
  then press the link button within the 30-second countdown. The pairing is saved. If the
  bridge stops recognizing the app, you're sent back to pairing.
- **Lights:** power, brightness, 10 color presets and hue/saturation sliders per light.
  **All lights** card plus **All on** / **All off**. Color temperature on white-ambiance
  bulbs, brightness only on dimmable bulbs, switch only on plugs. Unreachable lights are
  marked. Outside changes show up within 10 seconds. Slider drags are throttled to about
  10 commands a second.
- **Bridge settings:** name, IP, model, firmware, API version and Zigbee channel. Pair a
  different bridge or forget this one.
- **Web version:** `npm start`, then <http://localhost:8080/>. `--lan` serves it to the
  rest of your network. Pairing is stored in `server/config.json`. Only forwards to
  private IPs, only answers under this computer's own names, same-origin only.

**Tested with:** a Hue bridge v1 (`BSB001`, firmware 01043155, API 1.16.0) and two
Living Colors Bloom (`LLC011`) from the Android app. The web version was tested against
a simulated bridge in headless Chrome. See the README for other bridge models.

**Limitations:** lights only (no rooms, scenes, schedules or sensors). Local network
only. **Forget this bridge** doesn't remove the app from the bridge's whitelist.

This APK is signed with a different key than earlier test builds; uninstall those first.
