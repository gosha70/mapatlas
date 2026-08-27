<!-- SPDX-License-Identifier: Apache-2.0 -->

# MAP-ATLAS

**An open-source, domain-agnostic engine for interactive field mapping: record a track,
drop an event where it happened, attach a comment and photos, and — optionally — let a
pluggable AI analyze those photos.**

MAP-ATLAS knows nothing about fish, plants, or mushrooms. It knows about **places**,
**tracks**, **events**, **media**, and an optional **media analyzer**. The domain is
supplied by whoever consumes it:

| Consumer | Plugs in | Gets |
|---|---|---|
| A fishing journal | a fish-species analyzer | "log my catch on the water" |
| A foraging app | a mushroom/plant analyzer | "map where I found it, ID the species" |
| A field survey tool | no analyzer | "record a route and tag observations" |

MAP-ATLAS is the reusable core; the value-added domain, private data, and any
privacy/sharing rules live in the consuming application.

## Status

**Phase 0 complete; core implementation begins in Phase 1.**

The monorepo, toolchain, and enforcement are in place and green in CI: seven build units
wired with TypeScript project references, strict TypeScript, Vitest, ESLint/Prettier, and
the import-isolation and SPDX scanners that keep the one architectural rule honest. No
product runtime logic exists yet — the engine's data model, seams, and track logic are
[Phase 1](specs/roadmap.md).

The [`specs/`](specs/) directory remains the governing contract: build against it, and
change it in the same commit as any public interface it describes.

## What's here now (the build seed)

Everything in [`specs/`](specs/) is **harness-neutral** — the canonical source of truth,
written so that different build harnesses can consume the *same* brief:

- [`specs/PRD.md`](specs/PRD.md) — product requirements: users, problems, scope, non-goals.
- [`specs/architecture.md`](specs/architecture.md) — package layout, module boundaries, data model, offline + AI seams.
- [`specs/api.md`](specs/api.md) — the public TypeScript API contract (the interfaces to build against).
- [`specs/roadmap.md`](specs/roadmap.md) — phased delivery.
- [`specs/tasks.md`](specs/tasks.md) — the buildable backlog: epics → tasks with acceptance criteria.
- [`specs/decisions.md`](specs/decisions.md) — architecture decision log (ADRs).

[`CLAUDE.md`](CLAUDE.md) is the entry point for the **Claude Code** harness; it points at
the same `specs/`. Any other harness should read `specs/` directly.

## Design at a glance

- **TypeScript**, framework-agnostic **core** + a **MapLibre GL** renderer + thin **React** bindings.
- **Offline-first**: PMTiles offline map regions; a pluggable storage adapter (default IndexedDB).
- **Track recording** behind a `TrackRecorder` abstraction (web `watchPosition` + Wake Lock;
  a native adapter for background tracking in a Capacitor/Cordova shell).
- **AI is optional and pluggable**: a `MediaAnalyzer` interface (photo → labels/summary).
  No model is bundled; consumers provide on-device or remote analyzers.

## License

[Apache-2.0](LICENSE). Contributions are accepted under the **Developer Certificate of
Origin** — see [CONTRIBUTING.md](CONTRIBUTING.md). Every source file carries an
`SPDX-License-Identifier: Apache-2.0` header.

## Attribution & data licensing (downstream obligation)

MAP-ATLAS renders third-party map data. Consumers must honor the source licenses:
OpenStreetMap (ODbL), OpenSeaMap seamarks (ODbL, share-alike), NOAA charts/bathymetry
(US public domain). See [`specs/architecture.md`](specs/architecture.md#map-data--licensing).
