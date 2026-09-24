# Howl Web Companion

A free, browser-based companion to the [Howl Android app](https://github.com/jdtech1998-droid/Howl-2.0.1). It has the look and feel of the phone app and supports Howl's **Remote Play**, so a browser and a phone (or two browsers) can pair and drive each other.

**Live:** https://jdtech1998-droid.github.io/Howl-web-companion/

## What it does

- **Rider:** connect a DG-LAB Coyote 3 over Bluetooth, get a session code, and let your Driver control it. You set your own MAX per channel, send feedback buttons, and have an E-STOP.
- **Driver:** enter a Rider's code, then control power and send waves from the built-in generator. The Rider's feedback, MAX and E-STOP show up here.
- **Solo:** connect a Coyote 3 and play the generator locally.

The Rider on one side can be the web app or the phone app, and so can the Driver on the other. Both use the same DG-LAB V4 relay and the same command strings as the phone app (`remoteplay/` in the main repo).

## Browser support

| | Chrome / Edge (desktop, Android) | Safari (iPhone, Mac) / Firefox |
|---|---|---|
| Driver | ✅ | ✅ |
| Rider with a Coyote | ✅ | ❌ no Web Bluetooth |

Keep the tab open and visible during a session. Browsers slow down hidden tabs.

## Run locally

No build step. You need Node 18+ for the helper server and tests.

```sh
npm run serve   # http://localhost:8000 (Web Bluetooth needs localhost or HTTPS)
npm test        # protocol and stream tests
```

## Layout

```
index.html        the app
css/theme.css     Material 3 colors from the Android theme
js/protocol.js    relay frames, commands, Coyote packets (shared wire formats)
js/relay.js       relay WebSocket (ping, stale watchdog, close codes)
js/remote.js      Rider and Driver sessions
js/stream.js      Rider pulse buffer (A/B pairing, frequency smoothing, starvation fade)
js/coyote3.js     Coyote 3 over Web Bluetooth
js/generator.js   Driver wave generator
js/app.js         UI and the 10 Hz output loop
```

Not yet supported: DG-LAB Paw Prints, Coyote 2.

## License

MIT, see [LICENSE](LICENSE).
