# T6.1 — `OfflineRegionStore`

> Bars set 2026-09-04, **before implementation**, against `main` at `4e24b72`. The survey found
> `api.md` §7 already declaring both seams, `createMemoryMapAssetStore` already shipped as the
> double, and `packages/offline-pmtiles` a 17-line stub. One thing the contract could not
> express: whether a source's terms permit bulk download at all.

## What this reuses from T4.6 — infrastructure, not an exit

> **Corrected 2026-09-05.** This section claimed T4.6 had outstanding acceptance criteria and
> that T6.1's offline scenario would discharge one of them. Both were wrong: `tasks.md` marks
> T4.6 **Done** (2026-09-01, PR #9 and #10) and names what discharges each criterion. The
> ordering rationale below survives the correction; the double-exit claim does not.

T4.6 left behind the `/lab` route, the fixture track and simulated GPS, the egress-failing
browser harness, and two archives cut by `npm run fixture:build` — `terrain.pmtiles` (raster-DEM)
and `contours.pmtiles` (vector MVT), which are exactly the DEM/vector stack T6.1's bar demands.
Building T6.1 over that costs one scenario instead of a scenario plus a fixture pipeline.
**Increment 4 closes T6.1 only.**

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
- **Browser.** The **archive host** cut, *after* the app and the archives have loaded: region
  present → tiles render; region deleted, same cut → render fails. The second half is the
  positive control, and without it the first proves only that something rendered.

Neither half alone is the claim. **Cut the network after load**, or the app never boots and the
failure looks like the test working.

> **Narrowed during increment 4, and recorded rather than quietly done.** This said
> `page.route("**", abort)`. A blanket abort cannot coexist with the positive control: that
> control needs a *fresh realm* — the protocol is realm-scoped with no unregister and a
> `PMTiles` instance carries its own promise cache, so a re-mount in the same realm answers from
> the old registration — and a fresh realm needs a navigation, which a blanket abort kills along
> with the document. So the claim is **map data offline**: no byte of either archive over the
> network, asserted per archive and split by request kind, with the app's own origin still
> served. App-shell offline is T7.1's. See ADR-0035 and T6.1 in `tasks.md`.

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
4. **Offline render.** The browser scenario and its positive control, discharging T6.1's exit.

## Required mutations

- absence permits instead of refusing → the licence bar fails;
- an unknown `sourceId` is permitted → same;
- the refusal guards `download` but not `estimateSize` → the quote-then-refuse bar fails;
- the protocol handler returns bytes it fetched rather than bytes it stored → the provenance bar
  fails;
- `delete` leaves the assets behind → the positive control stops failing, which is itself the
  tell that the control has stopped controlling;
- the network cut before load → the scenario passes for the wrong reason, and must be caught by
  `/lab` reporting a failed step rather than by a wait timing out;
- `download()` range-requesting the archive instead of copying it whole → the "copied locally,
  not range-requested" bar fails. Requests are therefore counted **per archive and split by
  request kind**: a range read is the renderer reading an archive, a plain GET is `download()`
  copying one, and only the second is evidence of a copy.
