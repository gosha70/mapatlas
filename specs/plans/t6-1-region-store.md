# T6.1 — `OfflineRegionStore`

> Bars set 2026-09-04, **before implementation**, against `main` at `4e24b72`. The survey found
> `api.md` §7 already declaring both seams, `createMemoryMapAssetStore` already shipped as the
> double, and `packages/offline-pmtiles` a 17-line stub. One thing the contract could not
> express: whether a source's terms permit bulk download at all.

## Why this runs ahead of T4.6's remainder

T4.6's fixture track, simulated GPS and `/lab` route are built, and so is the zero-egress
scenario's infrastructure. What is left there is rendered-state evidence, the three-capture
differential over the pause, and the frame-time/memory baseline — plus the offline scenario,
which is **the same scenario T6.1 needs**. `OfflineRegionStore` *is* "archive persisted
locally", and the T4.6 archives are exactly the DEM/vector stack T6.1's bar demands. One
scenario discharges both exits; the other order writes it twice.

## Settled calls

1. **`offlineLicensed?: boolean`, and absence refuses** (ADR-0033). One check function reached
   from both `download()` and `estimateSize()`, because a UI able to quote a size for a region
   the store will then refuse has already misled its user. An unknown `sourceId` is refused for
   the same reason absence is: a source the store cannot see cannot be shown to be licensed.
2. **A three-state licence enum was rejected**, with the reason in the ADR so it is not
   re-proposed: behaviour turns on one bit, and a third state invites a fourth.

## The bar that will be got wrong

*"Proving bytes were copied locally, not range-requested."* **Zero network requests is not
evidence for it** — a service worker, an HTTP cache hit, or a `blob:` URL minted earlier all
produce zero requests while proving nothing about the store. The claim is about *provenance*,
and it splits across the seam where each half is observable:

- **Unit, at the protocol seam.** The store-backed handler MapLibre calls returns exactly the
  bytes `put()` stored, keyed by what `download()` wrote. Byte identity is asserted here, against
  `createMemoryMapAssetStore`. Byte identity cannot be observed inside the browser without
  reaching into MapLibre's internals, and trying is where a week goes.
- **Browser.** `page.route("**", abort)` installed *after* the app and archives have loaded:
  region present → tiles render; region deleted, same abort → render fails. The second half is
  the positive control, and without it the first proves only that something rendered.

Neither half alone is the claim. **Install the abort route after load**, or the app never boots
and the failure looks like the test working.

## Scope fence

Four methods — `download`, `list`, `delete`, `estimateSize` — the refusal path, and one offline
render. **Eviction, quota, resume and `persist()` are T6.2 / Phase 7** and do not enter here.

## Increments

1. **The licence flag.** `api.md` field and contract sentence, ADR-0033, `tiles.ts`,
   `OfflineLicenseError` and the guard, the lab's archives annotated. The public-interface
   change, reviewable apart from the store.
2. **The store.** `createPMTilesRegionStore` over `MapAssetStore`: the four methods, keys derived
   from region and source, the refusal wired to both entry points.
3. **The protocol seam.** The handler MapLibre reads through, with the byte-identity assertion.
4. **Offline render.** The browser scenario and its positive control, discharging both exits.

## Required mutations

- absence permits instead of refusing → the licence bar fails;
- an unknown `sourceId` is permitted → same;
- the refusal guards `download` but not `estimateSize` → the quote-then-refuse bar fails;
- the protocol handler returns bytes it fetched rather than bytes it stored → the provenance bar
  fails;
- `delete` leaves the assets behind → the positive control stops failing, which is itself the
  tell that the control has stopped controlling;
- the abort route installed before load → the scenario passes for the wrong reason and must be
  caught by the control rendering, not by the abort.
