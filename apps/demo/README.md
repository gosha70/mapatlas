<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS demo

A generic field logger built **only from the published package entry points** — no deep imports,
no internals. Record a track, drop an event where it happened, attach a photo, review the trip,
export it as GeoJSON, over a self-hosted map.

## Run it

```bash
npm install
npm run demo
```

That is the whole thing. It prints one URL — open it.

The first run cuts the map archives, which needs the network once and takes about a minute. Later
runs reuse them and start immediately. `Ctrl-C` stops it.

## What you should see

A map of one alpine massif: landmass, landuse, water and roads from an OpenStreetMap extract,
shaded relief and brown contour lines from a Copernicus elevation model above it, and **two
attribution lines** in the corner — one for each source, because they are two derived works under
two unrelated licences.

Then the loop: **Start recording** (the browser will ask for your location), tap the map to drop
an event, attach a photo, **Stop and review**, and **Export GeoJSON**.

## What it is not

- **Not offline yet.** Downloading a region for offline use, and the app working with no network,
  are the next increment. Everything above needs the servers `npm run demo` starts.
- **Not a global basemap.** The archives cover one small region; pan far and the map runs out.
  That is the point — they are cut locally rather than served from anyone's tile host.
- **No map tiles are in this repository.** `npm run demo` cuts them into `build/fixture/`, which
  git ignores. See `specs/decisions.md` ADR-0024 and ADR-0038 for the sources and their licences.

## If something goes wrong

- **"port 5175/5176 is already in use"** — something else is listening, often a previous run.
  Stop it and try again.
- **An error mentioning "HTTP Byte Serving"** — the archives are being served by something that
  ignores `Range`. PMTiles is read by range request, and the reader refuses a response carrying
  more bytes than it asked for. `npm run demo` uses a server that supports it; a plain static
  server such as `python3 -m http.server` does not.
