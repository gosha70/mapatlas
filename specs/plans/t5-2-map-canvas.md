# T5.2 — `<MapCanvas>`

> Bars set 2026-09-02, **before implementation**, against `main` at `144a1b8`.

## Survey: a reconciliation component over an already-complete controller

`MapController` already owns everything the component must do — the survey found a mutator for
every published prop except one:

| prop | reconciled through |
| --- | --- |
| `sources` | `setSources` |
| `terrain` | `setTerrain` |
| `presentation` | `setPresentation` |
| `track` | `renderTrack` |
| `events` | `renderEvents` |
| `livePoint` | `showLivePosition` |
| `draft` | `renderDraft` |
| `drawMode` / `onDraw` | `enterDrawMode` → returned exit |
| `onMapTap` / `onEventClick` | the controller's own subscriptions |
| **`style`** | **nothing — construction-only, by the controller's design** |

So `style` is the **one recreation boundary**: changing it destroys the controller and builds a
new one against the same container, and everything else reconciles through the existing
controller. Recreating for any other prop would churn a live WebGL context to do what a method
call does.

**SSR is a claim about the import chain, not the component.** `@mapatlas/react` currently has no
runtime import of `@mapatlas/maplibre`; `MapCanvas` introduces the first, which transitively
imports `maplibre-gl`. "No window at import" therefore has to be proven where it can fail: a
**Node-environment** test (no happy-dom) that first asserts `window` and `document` are absent,
then **dynamically imports** the barrel, then renders `<MapCanvas>` to a string via
`react-dom/server`. Dynamic, because a static import runs before the test body and would leave
"there was no DOM when the import happened" as an inference rather than evidence. The component
renders its container `<div>` and constructs the controller only in an effect, which never runs
on a server.

## Testing lanes

- **Vitest / happy-dom** — React lifecycle and delegation, against a counted fake controller
  through a private seam: `useMapCanvasInternal`-style internal entry point taking
  `create: (options) => MapController`, production-bound to `createMapController`. Nothing new in
  the published props; the seam stays off the barrel, `MUST_NOT_ESCAPE` covers it.
- **Vitest / node** — the SSR proof, in the environment where `window` genuinely does not exist.
- **Playwright** — only what needs a real MapLibre: the component driving a genuine map. Its
  harness shape (a React mount in the existing `e2e` setup) is checkpoint 2's first decision,
  not presumed here.

## Settled lifecycle rules

1. **Construction in an effect, never in render.** The controller owns a WebGL context; building
   it during render would leak one per re-render and break SSR twice over.
2. **`style` change ⇒ destroy and recreate; every other prop change ⇒ reconcile.** After
   recreation, the current state must be **logically present on the replacement controller** — a
   controller built from `style` alone would silently drop the track, events, terrain and draw
   session. "Present", not "a setter was called": `sources`, `terrain` and `presentation` may
   legitimately arrive in `createMapController(options)`, while track, events, live point, draft
   and the interaction wiring necessarily use controller operations. The test must not prescribe
   redundant setter calls.

   **The recreation test holds every other prop constant.** Mount with track, events, live
   point, draft, terrain, presentation, both listeners and an active draw session; change *only*
   `style`; prove the replacement carries the entire current state and the old controller is
   completely released — draw exited, subscriptions gone, `destroy` called. This is the test
   that kills the common implementation where independent prop effects simply do not rerun
   because their own dependencies did not change.
3. **Presence is lifecycle; identity is data.** The rule, stated as the full transition table so
   neither half can be quietly dropped:

   | transition | effect |
   | --- | --- |
   | `onMapTap` defined → defined, new identity | same subscription, latest callback |
   | `onMapTap` defined ↔ absent | subscribe / unsubscribe |
   | `onEventClick` | identical rule |
   | `drawMode: true`, `onDraw` defined → defined, new identity | same draw session, latest handlers |
   | `onDraw` defined → absent while `drawMode: true` | **exit** |
   | `onDraw` absent → defined while `drawMode: true` | **enter** |
   | `drawMode: true` with no `onDraw` | no active session |

   **Both halves are mutation-tested.** A suite proving only "identity change does not
   re-enter" would still pass with a session left alive after its handlers disappeared — the
   presence half is the one that suite cannot see.
4. **Draw mode enters and exits exactly once per activation.** `drawMode: true` (with handlers)
   enters; `false` calls the returned exit. The handlers passed to `enterDrawMode` are stable
   wrappers reading a latest-ref, because exiting and re-entering on a handler identity change
   would visibly drop the keyboard grab and roving focus mid-edit — and inline callbacks are the
   ordinary React case, not an exotic one. Unmount and style-recreation both exit before
   `destroy`.
5. **Absent props clear.** `track` gone ⇒ `renderTrack(null)`; likewise draft and live point —
   a prop that disappears must not leave its layer painted.
6. **StrictMode constructs one live controller.** Mount-cleanup-remount must destroy the first;
   two live controllers is two WebGL contexts on one container.

## Checkpoints

1. **Lifecycle + SSR** — the component, the internal seam, happy-dom delegation tests, the Node
   SSR test. Stop for review.
2. **Real-browser integration** — the AC's "renders track+events; toggling `drawMode` enters and
   exits cleanly" against a genuine map; decide the React mount harness first.
3. **Barrel + closure** — exact `api.md` §9 conformance (tuples, returns, key sets), move
   `MapCanvas` out of `NOT_YET_BUILT` — the assertion fails on export, as designed — leave
   `EventComposer` absent, close T5.2 in `tasks.md`.

## Required mutations

- construct the controller in render → SSR or StrictMode test fails;
- recreate on a non-style prop change → delegation counts fail (one construction);
- fail to re-apply current props after a style recreation → the new controller shows defaults;
- resubscribe on listener identity change → subscription counts fail;
- fail to unsubscribe when a listener prop is removed → the presence half fails;
- re-enter draw mode on `onDraw` identity change → enter/exit counts fail;
- leave the session alive when `onDraw` is removed while `drawMode` is true → the presence half
  fails;
- skip the draw exit on unmount or recreation → exit count fails;
- drop the `null` clears for absent props → clear-call assertions fail;
- StrictMode leaves two controllers → destroy count fails.

Every checkpoint stops for review before commit; gates are `npm run verify` and
`npm run check:packaging` (the packed surface changes only at checkpoint 3).
