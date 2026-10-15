# Engine work requested by the first real consumer (HookAtlas trip map)

> Status: **E3 and E2 complete** (T8.4, T8.5, ADR-0043; PR #75, merged as `80b797a` on 2026-10-14); **E1 deferred** by owner ruling 2026-10-14 · Date: 2026-10-14 · Origin: gosha70/hookatlas#5 (real-time fishing-trip
> map). Consumer-side plan: `hookatlas/specs/pitches/0034-trip-map-web-mvp/plan.md`.
>
> Owner preference recorded with the request: *where the enhancement belongs to MAP-ATLAS core
> logic, enhance MAP-ATLAS first.* This document is that list, and — just as important — the
> list of what HookAtlas needs that the engine's own decisions keep **out** of the engine.

## 1. What the consumer needs, and what already exists

HookAtlas #5 Phase 1 is: Start Trip → foreground GPS breadcrumb → one-tap pin → note + photo
without leaving the map → offline-first → review the finished trip. Against M1:

| Need | Engine today | Gap |
|---|---|---|
| Foreground recording, Wake Lock, pause-as-gap | `createWebTrackRecorder`, `useTrackRecorder` (§2, §9) | none |
| Crash recovery mid-trip | `autosaveMs` + `recoverInterruptedTrack` (§2) | none |
| One-tap pin + note + photo on the map | `MapCanvas` `onMapTap` + `EventComposer` `mode="photo"` (§9) | none |
| Domain fields on a pin (species, gear) | `FieldSpec` → `MapEvent.fields` (§9) | none |
| Review a finished trip | `TripReview` (§9) | none |
| Consumer-owned persistence + sync | `StorageAdapter` + `storageAdapterContract` (§5, §5c) | none — sync is the consumer's (PRD §5) |
| OSM raster basemap | `TileSource` `transport: "template"` (§7) | none |
| Wire format to the server | `trackToGeoJSON` / `geoJSONToTrack` (§10) | none |
| Install into a Next 14 App Router app | tarball route (api.md §0) | **E1, E3** |
| Run on React 18 | peer `react: ">=18"` | **E2** — untested |
| Record with the screen locked (#5 Phase 2) | seam only (`recorder:` injection) | **E4** = milestone M2 |
| On-device fish/gear detection (#5 Phase 4) | `MediaAnalyzer` seam, `noopAnalyzer` | E5 (later, optional) |

## 2. Evidence (spike, 2026-10-14)

Engine `origin/main` 7c3a8de packed per api.md §0; installed into HookAtlas `origin/main` 063d1a9
(Next 14.2.29, React 18.3.1) with `maplibre-gl@6.6.0` placed by the peer declaration. Scratch
worktrees only; nothing committed in either repo.

- `tsc --noEmit` (HookAtlas strict config, React 18 types) over a page using `MapCanvas`,
  `EventComposer`, `useTrackRecorder`, `useEventLog`, `createIdbStorageAdapter`: **pass**
  (53 engine declaration files in the program).
- `next build` with the engine behind a `"use client"` wrapper: **pass**; the route's first-load
  JS is **446 kB** (MapLibre dominates).
- `next build` importing `MapCanvas` directly into a Server Component: **fail** —
  `TypeError: (0, U.useRef) is not a function` while prerendering. The React package's modules
  carry no `"use client"` directive, so the RSC graph evaluates hooks on the server runtime.
- **Not exercised:** anything at runtime in a browser on React 18 (geolocation, map draw,
  composer save). Build-level evidence only.

## 3. Proposed engine work (do before HookAtlas Phase 1 builds on it)

### E1 — Publish `@mapatlas/*` to a registry — **deferred** (owner, 2026-10-14)
Publishing is a release decision, not a prerequisite for the integration. ADR-0042 already places
it after M1, so scheduling it later needs no reversal of that milestone. Until then consumers
install **commit-pinned tarballs**: packed from a named engine commit, with each tarball's SHA-256
recorded. The Next lane writes exactly that record (`build/next14-react18/ENGINE_PIN.json`), so the
same mechanism serves HookAtlas's CI.

### E2 — Make the React peer range true: a React 18 lane
`packages/react` declares `react: ">=18"`; the workspace pins `react@19.2.8`, so every test of the
bindings runs on 19. The range is a claim no test supports. Either:
- **(a, recommended)** add a CI lane that installs the packed packages into a React 18.3 consumer
  and runs the quick-start browser loop (`e2e/quick-start.e2e.ts`) there; or
- **(b)** narrow the peer to `>=19` — which pushes HookAtlas to React 19 / Next 15 before it can
  start, a large unrelated migration.

_AC:_ the quick-start loop (record → event with photo → review) passes in a browser on React 18.3
and on 19.x, from packed tarballs, in CI.

### E3 — Mark the client boundary in `@mapatlas/react`
Emit `"use client"` at the top of each component/hook module in `dist` (the directive must
survive the build; a barrel-level directive is not enough for per-module chunks in every bundler).
_AC:_ a Next App Router fixture whose **Server Component** imports `MapCanvas` and `TripReview`
from the package builds and prerenders the shell; the existing SSR-safety lane (no `window` at
import) still passes; Vite consumers are unaffected (directive is an inert string there).
Small, generic, and the spike's failure is the regression test.

### E4 — Native background `TrackRecorder` package (milestone M2) — before HookAtlas Phase 2
Already on the post-v1 list. Not needed for #5 Phase 1; required before #5 Phase 2 (screen-locked
recording). Decision to make when scheduled: **which background-geolocation plugin**. An
Apache-2.0 engine package should not make a paid licence mandatory, so the proposal is a
plugin-agnostic adapter (`@mapatlas/recorder-capacitor`) that takes the plugin instance by
injection, with a reference binding for one MIT plugin; a consumer that buys the commercial plugin
(HookAtlas's design doc names `@transistorsoft/capacitor-background-geolocation`) injects that
instead. Contract tests use fakes, never hardware (CLAUDE.md).

### E5 — Reference on-device analyzer (later, optional)
On the post-v1 list. Only relevant to #5 Phase 4; listed so it is not mistaken for Phase 1 work.

## 4. What stays in HookAtlas — by this engine's own decisions

These look generic but the engine has already ruled them out; moving them in would mean reversing
an ADR, not "enhancing core logic":
- **Track coarsening / endpoint trimming / dwell masking for sharing (PI-28).** ADR-0007 and
  PRD §5 *Out*: the engine exposes raw primitives and applies no privacy transform. Recommend
  keeping it so: a trim shipped by the engine invites consumers to treat it as a guarantee, while
  the guarantee is only what the consumer's adversarial tests establish.
- **Server sync, outbox, idempotency.** PRD §5 *Out* (accounts, servers, multi-user sync).
  HookAtlas implements `StorageAdapter` over its existing outbox and runs
  `storageAdapterContract` against it.
- **Species/gear fields, the fish-ID `MediaAnalyzer`, nautical `TileSource` configuration,
  Prisma/PostGIS models.** Consumer domain (CLAUDE.md, the one architectural rule).

## 5. Order

E3 and E2 first (done: T8.4 / T8.5, merged as `80b797a`). E1 is deferred; consumers use commit-pinned
tarballs. HookAtlas Phase 1 integration can start on tarballs from the commit that lands E2/E3. E4
is scheduled with HookAtlas Phase 2, not before. Beta deployment remains HookAtlas's next release
priority; engine work is in a different repository but still consumes engineering time.
