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
- Not built yet: Paw Prints, Coyote 2.

## Interop rules (do not break)
- Uses the same DG-LAB V4 relay (`wss://trex.dungeon-lab.cn/v4`) and the same text commands as the Android app.
- The wire commands (`howl-*`) must keep their names, or the phone app stops working with the web version.
- Don't propose changes to the Android app for this project.

## Naming
The public name is "Moan Web Companion". The original Howl (Amethyst-Sysadmin) license forbids redistributions from using the name "Howl". The user is asking the original author for permission. Don't use "Howl" in public-facing text.

## Status and testing
- Headless Edge test scripts drive the page through the Chrome DevTools Protocol (fake relay WebSocket, real file inputs, real mouse input). They are not in the repo.
- Tested: 14 unit tests, a Rider/Driver session through the live relay, a scripted UI session in headless Edge, and a live Remote Play test on 2026-09-23 with the Coyote unplugged (both directions work between the web page and the phone).
- Not tested: a real Coyote 3 with electrodes. Treat anything that changes output levels as safety-sensitive.

## Layout
- Below 1200px wide: the phone layout (power header, tab row, one tab at a time). Rider feedback on the Driver pops up over other tabs (safety words stay until tapped) and the Remote tab shows an unread count.
- 1200px and up: three columns. Left: the tab row and the open tab (Remote's tab button is hidden). Center: power, meters, mute/play, frequency range, device bar. Right: Remote, always visible, with E-STOP stuck to its bottom. Left and right are equal width so the power column stays centered.
- The breakpoint lives in two places that must match: `@media (min-width: 1200px)` in `css/app.css` and `wideQuery` in `js/app.js`.

## Next up
Activity tab port, in batches. Done: the toolkit (`activitycore.js`, `simplex.js`) and all 14 regular activities.
1. Next: the calibration activities (Calibrate power, frequency, position). They are excluded from random select by default. "Calibrate position" sets Howl's positional effect curve; on the web that value currently lives in `settings.funscript.positionalEffectCurve`, and the Funscript "Reset" button resets it too. Move it to its own setting when porting that activity.
Each activity: add the class to `activities.js`, its persisted options to `ACTIVITY_OPTION_DEFAULTS`, an entry in `ACTIVITY_TYPES` (Howl's order), and it is covered by the "every activity runs" test.

Not ported on purpose: Android's "remote latency" player setting (only for scripts sent to the phone by other apps).

## Working rules
- Confirm with the user before publishing or pushing anything visible. Pushing to `main` deploys the live site.
- Prefer small, reversible changes. Run `npm test` before committing.
