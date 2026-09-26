# Moan Web Companion

Free web companion to the Android app "Howl" (a DG-LAB Coyote controller). Live at https://jdtech1998-droid.github.io/Moan-web-companion/ (GitHub Pages, served from `main` at the root). Repo: jdtech1998-droid/Moan-web-companion (public).

## Stack
- Plain HTML/CSS/JS with ES modules. No build step, no bundler. Keep it that way.
- Files: `index.html`, `css/` (app.css, theme.css), `js/`, `test/`.
  - Core: app (page wiring and the 40 pulses/s output loop), protocol, coyote3, coyote2, pawprints, calibration, audioout + audiodsp + audio-worklet, relay, remote, stream, feedback.
  - Tabs: generator, manual + touchpad, funscript + player, activitycore + activities + simplex + controls + icons, pulsechart.
- `npm test` runs the unit tests. `npm run serve` starts a local server on http://localhost:8000.
- New Android features are ported close to line by line from `../Howl-2.0.1/app/src/main/java/com/example/howl/`. Icons come from its `res/drawable` path data.

## What v1 does
- Remote Play in both roles. The web Rider drives a Coyote 3 or Coyote 2 directly over Web Bluetooth (Chrome/Edge only). The type added in the Devices panel chooses the driver (`coyote3.js` or `coyote2.js`, same interface) and the Bluetooth picker filter, and `coyote` in app.js is replaced on each connection (`attachCoyote()` rewires it).
- Coyote 2 (a port of OutputCoyote2.kt): 20 pulses/s, channel A then B 50ms later, each channel 10 updates/s. It has no hardware power limit, so the page clamp is the only limit; a level the box reports above the limit is written back down on the next send.
- The Howl 2.0.1 layout: tabs Player, Generator, Activity, Manual, Remote, Settings; header row with Mute, Auto-increase power, Pulse chart, Swap channels; power bars that fill each channel panel.
- One active pulse source at a time (`state.source`: generator, manual, player, activity), like Howl's Player. Starting one stops the others; whatever plays is also what a Driver streams.
- Devices panel (a port of Howl's DevicesPanel and AddDeviceDialog in OutputManager.kt): a Devices card under the power controls (phone) or at the bottom of the center column (wide). "+" opens Add device, a dropdown picker of Coyote 3, Coyote 2, the three audio outputs and Paw Prints with Howl's descriptions and warnings. Rows have Howl's Bluetooth status icon (tap to connect or disconnect), battery, a gear that opens the matching Settings card, and a bin with a confirm dialog. Unlike Howl (up to 7 outputs) the page allows one Coyote, one audio output and one Paw Prints. The added Coyote type and Paw are saved in `settings.devices`; audio is not (always off on load). Adding a Bluetooth device starts connecting at once, while the click is still a user gesture.
- Output calibration (`js/calibration.js`, Settings > Calibration): Howl's power balance, frequency balance A/B, amplitude scaling and the shared positional effect curve, saved in `settings.calibration`. Applied in `tick()` only to pulses going to the local Coyote and the audio output, as Howl applies it in device outputs; meters, recorder and a Driver's stream stay uncalibrated. Every factor is at most 1, so it can only lower power (a unit test checks this).
- Paw Prints (`js/pawprints.js`, Settings > Paw Prints): a port of Howl's PawPrintsProtocol.kt and InputDevicePawPrints.kt. Buttons map to E-STOP (the page's own E-STOP, same as the Remote tab button), mute, or power up/down on both channels by the power step. A Paw silent for 2s is disconnected with a 10s warning toast, as a dead E-STOP must be visible. Headless tests fake it with `Page.addScriptToEvaluateOnNewDocument` defining `navigator.bluetooth`.
- Output tweaks (Settings > Tweaks, `settings.tweaks`, also in `js/calibration.js`): Howl's amplitude/frequency feel, flat frequency adjust and frequency invert, applied before calibration to local Coyote and audio output pulses only. Unlike calibration, an amplitude feel above 1 raises quiet pulses (never above 1).
- Audio outputs (Settings > Audio output): Howl's Continuous, Wavelet and Multi-pulse, for stereostim and audio-driven boxes (A = left, B = right). `audiodsp.js` is a close port of the three generators and AudioEngine (0.5s fade on play/stop, one pulse per 25ms block) with no browser APIs, so the unit tests run it; `audio-worklet.js` runs it on the audio thread; `audioout.js` owns the AudioContext and maps pulse frequency to Hz (Continuous: its own 50-4000Hz tone range; Wavelet 1-200Hz and Multi-pulse 1-100Hz: the page's frequency range, clamped).
  - Web-only safety additions: the output type is never saved, so it is always Off when the page opens; if pulses stop arriving for 250ms (e.g. a throttled background tab) it plays silence instead of holding the last pulse; E-STOP and every Rider stop (`riderZero`) cut it at once without the fade.
  - Headless Edge can test it: launch with `--autoplay-policy=no-user-gesture-required` and wrap `AudioWorkletNode` (via `Page.addScriptToEvaluateOnNewDocument`) to tap a ChannelSplitter + AnalyserNode per channel. Keep the analyser window short (fftSize 4096) or it still holds audio from before a change.
- All of Howl's device outputs (Coyote 3, Coyote 2, the three audio outputs) and its Paw Prints input are ported. Howl's RemoteControlServer (a local server other apps send scripts to) can't run in a web page.

## Interop rules (do not break)
- Uses the same DG-LAB V4 relay (`wss://trex.dungeon-lab.cn/v4`) and the same text commands as the Android app.
- The wire commands (`howl-*`) must keep their names, or the phone app stops working with the web version.
- Don't propose changes to the Android app for this project.

## Naming
The public name is "Moan Web Companion". The original Howl (Amethyst-Sysadmin) license forbids redistributions from using the name "Howl". The user is asking the original author for permission. Don't use "Howl" in public-facing text.

## Status and testing
- Headless Edge test scripts drive the page through the Chrome DevTools Protocol (fake relay WebSocket, real file inputs, real mouse input). They are not in the repo.
- Tested: 72 unit tests (`npm test`; new test files must be added to the script in `package.json`), a Rider/Driver session through the live relay, a scripted UI session in headless Edge, and a live Remote Play test on 2026-09-23 with the Coyote unplugged (both directions work between the web page and the phone).
- Not tested: a real Coyote 3 with electrodes. Treat anything that changes output levels as safety-sensitive.

## Layout
- Below 1200px wide: the phone layout (power header, tab row, one tab at a time). Rider feedback on the Driver pops up over other tabs (safety words stay until tapped) and the Remote tab shows an unread count.
- 1200px and up: three columns. Left: the tab row and the open tab (Remote's tab button is hidden). Center: power, meters, mute/play, frequency range, device bar. Right: Remote, always visible, with E-STOP stuck to its bottom. Left and right are equal width so the power column stays centered.
- The breakpoint lives in two places that must match: `@media (min-width: 1200px)` in `css/app.css` and `wideQuery` in `js/app.js`.

## Next up
The Activity tab port is complete: all 17 of Howl's activities, including the three calibration ones (excluded from random select by default). Their texts say "the slider below" because the web shows the calibration sliders under the text instead of in another screen. Nothing else is queued; ask the user what's next.
To add an activity: add the class to `activities.js`, its persisted options to `ACTIVITY_OPTION_DEFAULTS`, an entry in `ACTIVITY_TYPES` (Howl's order, but the three calibration activities are listed first at the user's request), and it is covered by the "every activity runs" test.

Not ported on purpose: Android's "remote latency" player setting (only for scripts sent to the phone by other apps).

## Working rules
- Confirm with the user before publishing or pushing anything visible. Pushing to `main` deploys the live site.
- Prefer small, reversible changes. Run `npm test` before committing.
