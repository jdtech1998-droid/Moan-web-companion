# Moan Web Companion

Free web companion to the Android app "Howl" (a DG-LAB Coyote controller). Live at https://jdtech1998-droid.github.io/Moan-web-companion/ (GitHub Pages, served from `main` at the root). Repo: jdtech1998-droid/Moan-web-companion (public).

## Stack
- Plain HTML/CSS/JS with ES modules. No build step, no bundler. Keep it that way.
- Files: `index.html`, `css/` (app.css, theme.css), `js/`, `test/`.
  - Core: app (page wiring and the 40 pulses/s output loop), protocol, coyote3, relay, remote, stream, feedback.
  - Tabs: generator, manual + touchpad, funscript + player, activitycore + activities + simplex + controls + icons, pulsechart.
- `npm test` runs the unit tests. `npm run serve` starts a local server on http://localhost:8000.
- New Android features are ported close to line by line from `../Howl-2.0.1/app/src/main/java/com/example/howl/`. Icons come from its `res/drawable` path data.

## What v1 does
- Remote Play in both roles. The web Rider drives a Coyote 3 directly over Web Bluetooth (Chrome/Edge only).
- The Howl 2.0.1 layout: tabs Player, Generator, Activity, Manual, Remote, Settings; header row with Mute, Auto-increase power, Pulse chart, Swap channels; power bars that fill each channel panel.
- One active pulse source at a time (`state.source`: generator, manual, player, activity), like Howl's Player. Starting one stops the others; whatever plays is also what a Driver streams.
- Output calibration (`js/calibration.js`, Settings > Calibration): Howl's power balance, frequency balance A/B, amplitude scaling and the shared positional effect curve, saved in `settings.calibration`. Applied in `tick()` only to pulses going to the local Coyote, as Howl applies it in device outputs; meters, recorder and a Driver's stream stay uncalibrated. Every factor is at most 1, so it can only lower power (a unit test checks this).
- Not built yet: Paw Prints, Coyote 2, Howl's output "Tweaks" (feel, invert, frequency adjust).

## Interop rules (do not break)
- Uses the same DG-LAB V4 relay (`wss://trex.dungeon-lab.cn/v4`) and the same text commands as the Android app.
- The wire commands (`howl-*`) must keep their names, or the phone app stops working with the web version.
- Don't propose changes to the Android app for this project.

## Naming
The public name is "Moan Web Companion". The original Howl (Amethyst-Sysadmin) license forbids redistributions from using the name "Howl". The user is asking the original author for permission. Don't use "Howl" in public-facing text.

## Status and testing
- Headless Edge test scripts drive the page through the Chrome DevTools Protocol (fake relay WebSocket, real file inputs, real mouse input). They are not in the repo.
- Tested: 42 unit tests (`npm test`; new test files must be added to the script in `package.json`), a Rider/Driver session through the live relay, a scripted UI session in headless Edge, and a live Remote Play test on 2026-09-23 with the Coyote unplugged (both directions work between the web page and the phone).
- Not tested: a real Coyote 3 with electrodes. Treat anything that changes output levels as safety-sensitive.

## Layout
- Below 1200px wide: the phone layout (power header, tab row, one tab at a time). Rider feedback on the Driver pops up over other tabs (safety words stay until tapped) and the Remote tab shows an unread count.
- 1200px and up: three columns. Left: the tab row and the open tab (Remote's tab button is hidden). Center: power, meters, mute/play, frequency range, device bar. Right: Remote, always visible, with E-STOP stuck to its bottom. Left and right are equal width so the power column stays centered.
- The breakpoint lives in two places that must match: `@media (min-width: 1200px)` in `css/app.css` and `wideQuery` in `js/app.js`.

## Next up
The Activity tab port is complete: all 17 of Howl's activities, including the three calibration ones (excluded from random select by default). Their texts say "the slider below" because the web shows the calibration sliders under the text instead of in another screen. Nothing else is queued; ask the user what's next (candidates: Paw Prints, Coyote 2, output Tweaks).
To add an activity: add the class to `activities.js`, its persisted options to `ACTIVITY_OPTION_DEFAULTS`, an entry in `ACTIVITY_TYPES` (Howl's order), and it is covered by the "every activity runs" test.

Not ported on purpose: Android's "remote latency" player setting (only for scripts sent to the phone by other apps).

## Working rules
- Confirm with the user before publishing or pushing anything visible. Pushing to `main` deploys the live site.
- Prefer small, reversible changes. Run `npm test` before committing.
