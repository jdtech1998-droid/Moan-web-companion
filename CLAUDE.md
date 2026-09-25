# Moan Web Companion

Free web companion to the Android app "Howl" (a DG-LAB Coyote controller). Live at https://jdtech1998-droid.github.io/Moan-web-companion/ (GitHub Pages, served from `main` at the root). Repo: jdtech1998-droid/Moan-web-companion (public).

## Stack
- Plain HTML/CSS/JS with ES modules. No build step, no bundler. Keep it that way.
- Files: `index.html`, `css/` (app.css, theme.css), `js/` (app, coyote3, feedback, generator, protocol, relay, remote, stream), `test/`.
- `npm test` runs the unit tests (protocol and stream). `npm run serve` starts a local server.

## What v1 does
- Remote Play in both roles. The web Rider drives a Coyote 3 directly over Web Bluetooth (Chrome/Edge only). The web Driver has a simple wave generator.
- The look and feel copies the Android app.
- Not built yet: Paw Prints, Coyote 2.

## Interop rules (do not break)
- Uses the same DG-LAB V4 relay (`wss://trex.dungeon-lab.cn/v4`) and the same text commands as the Android app.
- The wire commands (`howl-*`) must keep their names, or the phone app stops working with the web version.
- Don't propose changes to the Android app for this project.

## Naming
The public name is "Moan Web Companion". The original Howl (Amethyst-Sysadmin) license forbids redistributions from using the name "Howl". The user is asking the original author for permission. Don't use "Howl" in public-facing text.

## Status and testing
- Tested: 14 unit tests, a Rider/Driver session through the live relay, a scripted UI session in headless Edge, and a live Remote Play test on 2026-09-23 with the Coyote unplugged (both directions work between the web page and the phone).
- Not tested: a real Coyote 3 with electrodes. Treat anything that changes output levels as safety-sensitive.

## Next up
1. Safety fix: on the web Driver, Rider feedback (STOP, E-STOP, Pause, Yield) is only visible on the Remote tab. Add pop-ups on other tabs (safety ones stay until tapped) plus an unread badge on the Remote tab button. Not implemented yet. It touches `index.html`, `css/app.css`, `js/app.js`.
2. Update the UI to match the current Howl 2.0.1 Android app: tabs Player, Generator, Activity, Manual, Remote, Settings; a header row with Auto-increase power, Pulse chart and Swap channels; larger power bars.

## Working rules
- Confirm with the user before publishing or pushing anything visible. Pushing to `main` deploys the live site.
- Prefer small, reversible changes. Run `npm test` before committing.
