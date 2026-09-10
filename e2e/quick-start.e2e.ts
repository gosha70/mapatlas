// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { DEFAULT_DATABASE_NAME, STORE } from "@mapatlas/storage-idb";

import { consoleFor, fixturePng, watchConsole } from "./fixtures/browser.js";
import { countColour } from "./fixtures/pixels.js";
import { settleRender } from "./fixtures/rendered.js";

/**
 * The getting-started example, executed (T7.2 increment 1).
 *
 * **Why this file exists.** `PRD.md` §6 asks that a developer reach a working
 * record → pin → photo → review loop by following the documentation, and `check:packaging`
 * already proves the half of that claim a compiler can see: the example typechecks against the
 * packed tarballs, in a project with no workspace resolution. `tsc` cannot tell whether a map
 * mounts, whether a fix is kept, or whether a photo comes back out of storage — so the same
 * example, built from the same tarballs by its own vite, is driven here in a real browser.
 *
 * **Nothing here is the demo.** `apps/demo` is the full application and has its own scenarios;
 * this is the minimal example a reader copies, on its own origin, served from its own build.
 *
 * **Each step on its own evidence.** "A review appeared" is satisfied by a loop that recorded
 * nothing, pinned nothing and attached nothing — the trap `app-loop.e2e.ts` was written against
 * and was caught by once. So the map is attributed to a colour only the example's own style
 * paints, the recording to a distance only a multi-fix track has, the photo to an image the
 * review resolved through the store, and the write to the consumer's own database.
 */

const EXAMPLE = "http://127.0.0.1:5178";

/**
 * The water fill the example's `map-source.ts` paints, and nothing else on that map paints.
 *
 * A named colour is attributable in a way a screenshot difference is not: its presence is that
 * layer having found geometry in the archive, and its absence is that layer drawing nothing.
 * It comes from tile data rather than from a background paint on purpose — a background would
 * still be painted by a map with no sources at all, which is one of the mutations this must
 * fail against.
 */
const WATER_FILL: readonly [number, number, number] = [0x0f, 0x8a, 0x7a];

/** Inside the ground the served archive covers, and where the example's camera opens. */
const HOME = { latitude: 45.84, longitude: 6.865, accuracy: 5 };

const PHOTO = {
  name: "field-shot.png",
  mimeType: "image/png",
  // A real, decodable PNG. A signature followed by arbitrary bytes round-trips through storage
  // perfectly and renders as a zero-sized broken image — a fixture defect wearing an app
  // defect's clothes.
  buffer: fixturePng(),
};

test.use({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  permissions: ["geolocation"],
  geolocation: HOME,
});

/** How many pixels of the example's water fill the live map is painting. */
async function waterPixels(page: Page): Promise<number> {
  const map = page.locator("#map");
  await settleRender(map);
  return countColour(await map.locator("canvas").screenshot(), WATER_FILL);
}

/**
 * Record two fixes, pin an event with a photo on it, and finalize.
 *
 * Every step is the interaction a person performs — real clicks, the real file chooser — never
 * a handler called directly. The two fixes are far apart because the default sampling policy
 * keeps a fix only after 10 m: a track that kept one point is not a trip.
 */
async function recordPinAndReview(page: Page): Promise<void> {
  await page.locator("#start").click();
  await expect(page.locator("#status")).toHaveAttribute("data-status", "recording");

  for (const fix of [
    { latitude: 45.842, longitude: 6.867, accuracy: 5 },
    { latitude: 45.845, longitude: 6.87, accuracy: 5 },
  ]) {
    await page.context().setGeolocation(fix);
    await page.waitForTimeout(250);
  }

  const box = await page.locator("#map canvas").boundingBox();
  if (box === null) throw new Error("the example's map drew no canvas to tap");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const chooser = page.waitForEvent("filechooser");
  await page.locator(".mapatlas-composer-photo").click();
  await (await chooser).setFiles(PHOTO);
  // The preview proves the bytes decoded, not merely that a file was selected.
  await expect(page.locator(".mapatlas-composer-preview")).toBeVisible();
  await page.locator(".mapatlas-composer-comment").fill("a note");
  await page.locator(".mapatlas-composer-save").click();

  await expect(page.locator("#status")).toHaveAttribute("data-status", "recording");
  await expect(page.locator(".mapatlas-composer-save")).toHaveCount(0);

  await page.locator("#stop").click();
  await expect(page.locator("#review")).toBeVisible();
}

interface Stored {
  readonly tracks: { id: string; points: number }[];
  readonly events: { id: string; trackId?: string | undefined; blobKeys: string[] }[];
  /** The bytes behind each `blobKey`, in order; `null` where the key resolved to nothing. */
  readonly blobs: (number[] | null)[];
}

/**
 * What the example's own storage holds, read straight out of IndexedDB.
 *
 * **The names come from the package, not from this file.** `DEFAULT_DATABASE_NAME` and `STORE`
 * are published by `@mapatlas/storage-idb`, so a schema that renamed a store would fail here
 * rather than have this probe read a database nobody writes to. It cannot go through the
 * example's own module the way `app-loop.e2e.ts` goes through the demo's factory: this lane
 * serves a *built* bundle, whose chunks have no stable specifier to import.
 */
function readStored(page: Page): Promise<Stored> {
  return page.evaluate(
    async ({ database, stores }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(new Error(`could not open ${database}: ${String(request.error)}`));
        };
      });

      const read = <T>(store: string, key?: string): Promise<T> =>
        new Promise((resolve, reject) => {
          const objects = db.transaction(store, "readonly").objectStore(store);
          const request = key === undefined ? objects.getAll() : objects.get(key);
          request.onsuccess = () => {
            resolve(request.result as T);
          };
          request.onerror = () => {
            reject(new Error(`could not read ${store}: ${String(request.error)}`));
          };
        });

      const tracks = await read<{ id: string; points: unknown[] }[]>(stores.tracks);
      const events = await read<{ id: string; trackId?: string; media: { blobKey?: string }[] }[]>(
        stores.events,
      );

      const keys = events.flatMap((event) =>
        event.media.map((item) => item.blobKey).filter((key) => key !== undefined),
      );
      const blobs: (number[] | null)[] = [];
      for (const key of keys) {
        const blob = await read<Blob | undefined>(stores.blobs, key);
        blobs.push(blob === undefined ? null : [...new Uint8Array(await blob.arrayBuffer())]);
      }

      return {
        tracks: tracks.map((track) => ({ id: track.id, points: track.points.length })),
        events: events.map((event) => ({
          id: event.id,
          trackId: event.trackId,
          blobKeys: event.media.map((item) => item.blobKey).filter((key) => key !== undefined),
        })),
        blobs,
      };
    },
    { database: DEFAULT_DATABASE_NAME, stores: STORE },
  );
}

/**
 * Make the events store refuse writes, and watch the blobs store while it does.
 *
 * **Injected below the engine, not into it.** The failure has to arrive where a real one would —
 * inside the adapter's own transaction, after `EventComposer` has already written the photo and
 * handed its `blobKey` over — and the example is a built bundle with no seam a test can reach. So
 * `IDBObjectStore.prototype` is patched before any script runs: `put` on `events` throws, and
 * `put`/`delete` on `blobs` record their keys so the scenario can say what was written and what
 * was given back rather than inferring it from an empty store.
 *
 * `cleanup` chooses which of the two failures the example has to survive. `"succeeds"` is the
 * ordinary case: the write is refused and the photo is given back. `"rejects"` is the one the
 * example's own comment promises to handle and that nothing else here reaches — the delete fails
 * too, so the bytes may or may not still be there and the notice has to say so rather than guess.
 * Recording the delete *before* refusing it is deliberate: "was it attempted" and "did it work"
 * are different questions, and a probe that only saw successes could not tell them apart.
 */
async function refuseEventWrites(
  page: Page,
  { cleanup }: { cleanup: "succeeds" | "rejects" } = { cleanup: "succeeds" },
): Promise<void> {
  await page.addInitScript(
    ({ blobs, events, refuseDeletes }) => {
      const probe: { written: string[]; deleted: string[] } = { written: [], deleted: [] };
      (window as unknown as { __blobs: typeof probe }).__blobs = probe;

      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function patched(
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ): IDBRequest<IDBValidKey> {
        if (this.name === events) throw new Error("injected: the events store refuses writes");
        if (this.name === blobs && typeof key === "string") probe.written.push(key);
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };

      const remove = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function patched(
        this: IDBObjectStore,
        key: IDBValidKey | IDBKeyRange,
      ): IDBRequest<undefined> {
        if (this.name === blobs && typeof key === "string") {
          probe.deleted.push(key);
          if (refuseDeletes) throw new Error("injected: the blobs store refuses deletes");
        }
        return remove.call(this, key);
      };
    },
    { blobs: STORE.blobs, events: STORE.events, refuseDeletes: cleanup === "rejects" },
  );
}

/**
 * Record a fix, pin an event with a photo, and try to save it — the shared prefix of the two
 * rejected-write scenarios below, which differ only in what happens to the cleanup.
 */
async function pinAPhotoThatCannotBeSaved(page: Page): Promise<void> {
  await page.goto(EXAMPLE);

  await page.locator("#start").click();
  await expect(page.locator("#status")).toHaveAttribute("data-status", "recording");
  await page.context().setGeolocation({ latitude: 45.842, longitude: 6.867, accuracy: 5 });
  await page.waitForTimeout(250);

  const box = await page.locator("#map canvas").boundingBox();
  if (box === null) throw new Error("the example's map drew no canvas to tap");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const chooser = page.waitForEvent("filechooser");
  await page.locator(".mapatlas-composer-photo").click();
  await (await chooser).setFiles(PHOTO);
  await expect(page.locator(".mapatlas-composer-preview")).toBeVisible();
  await page.locator(".mapatlas-composer-save").click();
}

/** Which blob keys the store was handed, and which it was asked to give back. */
function blobTraffic(page: Page): Promise<{ written: string[]; deleted: string[] }> {
  return page.evaluate(
    () => (window as unknown as { __blobs: { written: string[]; deleted: string[] } }).__blobs,
  );
}

/** Every key still in the blobs store — an orphaned photo is one nothing references. */
function blobsRemaining(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ database, store }) =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open(database);
        open.onerror = () => {
          reject(new Error(`could not open ${database}`));
        };
        open.onsuccess = () => {
          const keys = open.result.transaction(store, "readonly").objectStore(store).getAllKeys();
          keys.onsuccess = () => {
            resolve(keys.result.map(String));
          };
          keys.onerror = () => {
            reject(new Error(`could not list ${store}`));
          };
        };
      }),
    { database: DEFAULT_DATABASE_NAME, store: STORE.blobs },
  );
}

test("the example's map draws from the source the example was given", async ({ page }) => {
  const console_ = watchConsole(page);
  await page.goto(EXAMPLE);

  /**
   * **Not "a canvas exists".** A canvas proves a component mounted, and T7.1 established that a
   * map can mount, parse a style, emit `sourcedata` and never build a tile — the failure mode
   * MapLibre's worker URL causes, and the one a smoke test cannot see. Counting a colour that
   * only the example's `water` layer paints attributes the render to that source having been
   * declared, fetched by range request, and drawn.
   */
  expect(await waterPixels(page)).toBeGreaterThan(0);

  expect(console_.problems()).toStrictEqual([]);
});

test("the loop: a recorded trip carries an event with a photo, and the review renders it", async ({
  page,
}) => {
  watchConsole(page);
  await page.goto(EXAMPLE);
  await recordPinAndReview(page);

  const review = page.locator("#review");

  /**
   * **The recorder kept more than one fix**, read from what the review reports rather than from
   * the canvas. A track with a single point has a distance of exactly zero, so a non-zero
   * distance is the smallest honest statement that the recording is a trip.
   */
  const stats = review.locator(".mapatlas-trip-stats");
  await expect(stats).toBeVisible();
  const text = (await stats.textContent()) ?? "";
  const distance = /Distance\s*([\d.]+)\s*km/.exec(text);
  if (distance?.[1] === undefined) throw new Error(`no distance in the stats panel: ${text}`);
  expect(Number(distance[1])).toBeGreaterThan(0);

  /**
   * **The photo, in the review.** The image is resolved from the `blobKey` the composer wrote,
   * through the store the example handed `TripReview` (ADR-0028) — so a visible image here means
   * the whole chain held: capture → blob → event → bind to the finalized track → look up →
   * paint. It is the one observable that needs the review to exist.
   */
  await expect(review.locator("img").first()).toBeVisible();

  expect(consoleFor(page).problems()).toStrictEqual([]);
});

test("the event, its photo and the trip are in the example's own storage", async ({ page }) => {
  watchConsole(page);
  await page.goto(EXAMPLE);
  await recordPinAndReview(page);

  const stored = await readStored(page);

  // A trip that is a trip: the recorder kept both fixes, in the store rather than in a hook.
  expect(stored.tracks).toHaveLength(1);
  expect(stored.tracks[0]?.points).toBeGreaterThan(1);

  // The event reached storage, carrying a `blobKey` and bound to the finalized track.
  expect(stored.events).toHaveLength(1);
  expect(stored.events[0]?.blobKeys).toHaveLength(1);
  expect(stored.events[0]?.trackId).toBe(stored.tracks[0]?.id);

  // And the key resolves to the bytes the picker was handed — not merely to *some* blob, which
  // is what an event whose photo was dropped and replaced would also look like.
  expect(stored.blobs).toStrictEqual([[...PHOTO.buffer]]);

  expect(consoleFor(page).problems()).toStrictEqual([]);
});

test("a refused event write gives the photo back, says so, and leaves the trip finishable", async ({
  page,
}) => {
  /**
   * **The obligation `EventComposer` hands over, checked rather than assumed.** The composer
   * seals itself before calling `onSave`, so from that moment the consumer owns the bytes and
   * the composer can neither retry nor cancel (ADR-0027). Everything that can go wrong from
   * there goes wrong in one place — the write rejects — and the example is what a reader copies,
   * so a version that leaked the photo and stranded the trip would teach exactly that.
   */
  const console_ = watchConsole(page);

  await refuseEventWrites(page, { cleanup: "succeeds" });
  await pinAPhotoThatCannotBeSaved(page);

  // **The failure is visible**, not swallowed into a console nobody reads.
  await expect(page.locator("#failure")).toBeVisible();

  // **The photo existed before the rejection.** Without this the two assertions below are
  // satisfied by a composer that never wrote a blob at all, which is a different story with the
  // same ending.
  const traffic = await blobTraffic(page);
  expect(traffic.written).toHaveLength(1);

  // **And it was given back.** The key the composer wrote is the key the example released.
  expect(traffic.deleted).toStrictEqual(traffic.written);
  expect(await blobsRemaining(page)).toStrictEqual([]);

  /**
   * **The trip is still finishable.** This is the half that is easy to miss: the composition has
   * to close, or Stop stays disabled with no control able to clear it — a trip with no exit,
   * which is worse than the failed write it came from.
   */
  await expect(page.locator(".mapatlas-composer-save")).toHaveCount(0);
  await expect(page.locator("#stop")).toBeEnabled();
  await page.locator("#stop").click();
  await expect(page.locator("#review")).toBeVisible();

  // **No declaration for the injected failure, deliberately.** It is caught where it happens and
  // reported into the page, so nothing reaches the console — and asserting that is a stronger
  // statement than excusing an error would have been. A first draft of this scenario declared one
  // and failed here, saying the expected error never arrived.
  expect(console_.problems()).toStrictEqual([]);
});

test("a cleanup that fails too is reported as unconfirmed, and still leaves the trip finishable", async ({
  page,
}) => {
  /**
   * **The branch the example's own comment promises and nothing else reaches.** Giving the photo
   * back can fail on its own: the write is refused, the release is attempted, and the delete is
   * refused as well. The bytes may or may not still be there, and the example's contract is that
   * it says so rather than guessing — a notice claiming the photo was discarded would be a
   * statement it has no evidence for, and silence would be worse.
   *
   * Everything the confirmed-cleanup scenario proves about recovery has to hold here too. A
   * second failure inside the failure path is exactly where a composer gets left open.
   */
  const console_ = watchConsole(page);

  await refuseEventWrites(page, { cleanup: "rejects" });
  await pinAPhotoThatCannotBeSaved(page);

  await expect(page.locator("#failure")).toBeVisible();

  // The release was attempted on the key the composer wrote — the delete is recorded before it is
  // refused, so "attempted" is observed rather than inferred from the notice.
  const traffic = await blobTraffic(page);
  expect(traffic.written).toHaveLength(1);
  expect(traffic.deleted).toStrictEqual(traffic.written);

  // And it did not work: the bytes are still there. This is what separates this scenario from the
  // one above, where the same two assertions hold and the store ends empty.
  expect(await blobsRemaining(page)).toStrictEqual(traffic.written);

  // **The notice names the cleanup as unconfirmed**, so a reader is told what is uncertain rather
  // than being handed a reason that implies the photo is gone.
  await expect(page.locator("#failure")).toContainText("1 photo left unconfirmed");

  // Recovery is unchanged by the second failure: the composition closes and the trip finishes.
  await expect(page.locator(".mapatlas-composer-save")).toHaveCount(0);
  await expect(page.locator("#stop")).toBeEnabled();
  await page.locator("#stop").click();
  await expect(page.locator("#review")).toBeVisible();

  // No rejection escapes. `releaseMedia` catches the failed delete itself; a version that let it
  // through would leave `save`'s own `catch` unfinished and surface here as an unhandled rejection.
  expect(console_.problems()).toStrictEqual([]);
});
