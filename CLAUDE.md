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

## Layout
- Below 1200px wide: the phone layout (power header, tab row, one tab at a time). Rider feedback on the Driver pops up over other tabs (safety words stay until tapped) and the Remote tab shows an unread count.
- 1200px and up: three columns. Left: the tab row and the open tab (Remote's tab button is hidden). Center: power, meters, mute/play, frequency range, device bar. Right: Remote, always visible, with E-STOP stuck to its bottom. Left and right are equal width so the power column stays centered.
- The breakpoint lives in two places that must match: `@media (min-width: 1200px)` in `css/app.css` and `wideQuery` in `js/app.js`.

## Next up
1. Update the UI to match the current Howl 2.0.1 Android app: tabs Player, Generator, Activity, Manual, Remote, Settings; a header row with Auto-increase power, Pulse chart and Swap channels; larger power bars. On wide screens the new tabs go in the left column and the header row in the center column.

## Working rules
- Confirm with the user before publishing or pushing anything visible. Pushing to `main` deploys the live site.
- Prefer small, reversible changes. Run `npm test` before committing.
