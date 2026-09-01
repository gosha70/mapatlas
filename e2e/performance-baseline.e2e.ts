// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { createRequire } from "node:module";

import { consoleFor, watchConsole } from "./fixtures/browser.js";
import { changedMask, countMask, decodePng } from "./fixtures/pixels.js";
import { mapOf, settleRender } from "./fixtures/rendered.js";

/**
 * The T4.6 baseline: numbers to compare a later run against, and **no thresholds**.
 *
 * A threshold picked here would be a guess about this machine, and a guess that fails a future
 * run teaches nothing about the run. What makes a baseline usable later is not the number but
 * the method beside it, so everything that would change the number is recorded with it.
 *
 * **What the frame metric is.** `requestAnimationFrame` deltas are a frame-*delivery* interval,
 * not a render duration. On a settled map the callback reports the display scheduler: at 60 Hz
 * it reads about 16.7 ms whether the renderer spent 2 ms or 14 ms. It carries information when
 * frames are *missed* and intervals jump to roughly 33 or 50 ms. So sampling an idle page would
 * measure the monitor, and nothing here may be read as "the renderer took 16.7 ms".
 *
 * Which is why the samples are taken during a **deterministic camera workload** over the same
 * full stack a person opening `/lab` sees — terrain, hillshade, contours, marks and the whole
 * 5,400-point recording. No lightweight style, nothing switched off, no mode that exists for
 * the measurement.
 *
 * **And the largest caveat of all, recorded because the run reports it rather than because it
 * was anticipated: this browser rasterises in software.** The WebGL renderer string comes back
 * as SwiftShader, so the missed frames these numbers show are the CPU drawing a map that a GPU
 * would composite. They are a baseline for *this harness* — useful for noticing that a later
 * change made the same harness slower — and they are not a statement about what anyone with a
 * graphics card sees. Every number here carries its renderer string for that reason.
 */

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const DEMO = "http://127.0.0.1:5175";
const ARCHIVES = "http://127.0.0.1:5176";

/** The fixture as it ships: every source, every mark, framed on the whole recording. */
const FULL_STACK =
  `${DEMO}/lab?terrain=${encodeURIComponent(`${ARCHIVES}/terrain.pmtiles`)}` +
  `&contours=${encodeURIComponent(`${ARCHIVES}/contours.pmtiles`)}`;

/**
 * The workload, as keystrokes.
 *
 * **Keyboard rather than wheel or drag, because the endpoint has to be the same every run.**
 * MapLibre's keyboard handler moves a fixed step per press; wheel zoom is eased and
 * time-dependent, so repeated wheels accumulate differently on a slower machine and the camera
 * would finish somewhere else. A camera that ends somewhere else is a different workload.
 *
 * It does **not** return to where it started, and an earlier version of this comment claimed it
 * did. The pans are separated by a zoom, so four steps right at one zoom and four steps left at
 * another cover different ground — measured: 99.9% of pixels differ between the settled view
 * before and after. Reproducibility comes from the *starting* camera and the fixed script, not
 * from the path closing. And since the view does end somewhere else, that difference is what
 * proves the workload moved the map at all.
 *
 * It also exercises the keyboard path the project commits to keeping reachable.
 */
const WORKLOAD: readonly (readonly [string, number])[] = [
  ["ArrowRight", 4],
  ["ArrowDown", 4],
  ["Equal", 2],
  ["Shift+ArrowUp", 2],
  ["ArrowLeft", 4],
  ["ArrowUp", 4],
  ["Minus", 2],
  ["Shift+ArrowDown", 2],
];
/** Between presses, so each eased move is under way before the next begins. */
const PRESS_INTERVAL_MS = 250;
/** Frames discarded after the render settles, before sampling begins. */
const WARM_UP_FRAMES = 30;

const PLAYWRIGHT_VERSION: string = (
  createRequire(import.meta.url)("@playwright/test/package.json") as { version: string }
).version;

interface FrameSamples {
  readonly deltas: number[];
  readonly durationMs: number;
  readonly loaf: { duration: number; renderMs: number }[];
  readonly loafSupported: boolean;
}

/** Start collecting frame callbacks and long-animation-frame entries in the page. */
async function startSampling(page: Page): Promise<void> {
  await page.evaluate((warmUp) => {
    const store = globalThis as unknown as {
      __frames: number[];
      __loaf: { duration: number; renderMs: number }[];
      __stop: boolean;
      __warmUp: number;
    };
    store.__frames = [];
    store.__loaf = [];
    store.__stop = false;
    store.__warmUp = warmUp;
    const tick = (t: number): void => {
      // Warm-up frames are counted down and dropped here rather than trimmed afterwards, so
      // the recorded sample count is the number of frames the statistics were taken over.
      if (store.__warmUp > 0) store.__warmUp -= 1;
      else store.__frames.push(t);
      if (!store.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    if (PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const loaf = entry as PerformanceEntry & { renderStart?: number };
          store.__loaf.push({
            duration: entry.duration,
            renderMs:
              loaf.renderStart === undefined || loaf.renderStart === 0
                ? 0
                : entry.startTime + entry.duration - loaf.renderStart,
          });
        }
      }).observe({ type: "long-animation-frame", buffered: false });
    }
  }, WARM_UP_FRAMES);
}

async function stopSampling(page: Page): Promise<FrameSamples> {
  return page.evaluate(() => {
    const store = globalThis as unknown as {
      __frames: number[];
      __loaf: { duration: number; renderMs: number }[];
      __stop: boolean;
    };
    store.__stop = true;
    const frames = store.__frames;
    const deltas: number[] = [];
    for (let i = 1; i < frames.length; i += 1) deltas.push(frames[i]! - frames[i - 1]!);
    return {
      deltas,
      durationMs: frames.length < 2 ? 0 : frames[frames.length - 1]! - frames[0]!,
      loaf: store.__loaf,
      loafSupported: PerformanceObserver.supportedEntryTypes.includes("long-animation-frame"),
    };
  });
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const at = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[at]!;
}

test.beforeEach(({ page }) => {
  watchConsole(page);
});

test.afterEach(({ page }) => {
  expect(consoleFor(page).problems()).toEqual([]);
});

test("records a frame-delivery and memory baseline for the full stack", async ({
  page,
  context,
}) => {
  // **A harness budget, not a performance threshold — and nothing here may be read as one.**
  // The run is a page load, three settled renders and a *fixed* 6 s workload, and Playwright's
  // default is 30 s for a whole test. On Ubuntu CI that is not enough: the settle before
  // sampling alone measured 3.5–4.9 s there against 0.65 s locally, and both attempts timed out
  // inside the workload loop.
  //
  // The workload is deliberately **not** shortened to fit. Trimming presses or the interval to
  // satisfy a framework default would let the harness decide what gets measured, and the
  // resulting numbers would describe a different workload on every machine that needed a
  // different trim. The budget moves; the measurement does not.
  test.setTimeout(180_000);

  // **The browser's own version, not `navigator.userAgent`.** Playwright's device profile
  // rewrites the page's user-agent string — it claims Windows on a macOS host — so a baseline
  // that recorded it would attribute every number to the wrong platform.
  const cdp = await context.newCDPSession(page);
  const version = await cdp.send("Browser.getVersion");
  await cdp.send("Performance.enable");

  /** JS heap, with a collection forced first so the figure is live objects and not garbage. */
  const heapBytes = async (): Promise<number> => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? Number.NaN;
  };

  await page.goto(FULL_STACK, { waitUntil: "load" });
  await page.waitForSelector('#status[data-assembled="true"]', { timeout: 120_000 });
  await page.waitForFunction(() => document.querySelectorAll("#map canvas").length > 0, undefined, {
    timeout: 30_000,
  });
  // Warm-up part one: the map has stopped drawing before anything is measured. Part two is the
  // discarded frames inside the sampler.
  const settled = await settleRender(mapOf(page));
  const before = await heapBytes();

  // What memory this can and cannot speak for, decided before the run rather than after it.
  const renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return info === null || info === undefined || gl === null
      ? "unavailable"
      : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  });
  const memory = await page.evaluate(() => ({
    crossOriginIsolated: globalThis.crossOriginIsolated,
    standardApi: typeof (performance as unknown as { measureUserAgentSpecificMemory?: unknown })
      .measureUserAgentSpecificMemory,
  }));

  const canvas = page.locator("#map canvas").first();
  await canvas.focus();
  await startSampling(page);

  for (const [key, presses] of WORKLOAD) {
    for (let i = 0; i < presses; i += 1) {
      await page.keyboard.press(key);
      await page.waitForTimeout(PRESS_INTERVAL_MS);
    }
  }

  const samples = await stopSampling(page);
  const after = await heapBytes();

  // **The workload has to have moved the map.** Without this the run degrades into sampling an
  // idle page, which reports a clean 60 Hz cadence and means nothing at all — the exact shape
  // of vacuous evidence this fixture exists to refuse.
  const moved = await settleRender(mapOf(page));
  const shifted = countMask(changedMask(decodePng(settled.image), decodePng(moved.image)));
  const pixels = 1280 * 720;

  expect(samples.deltas.length, "no frames were sampled at all").toBeGreaterThan(60);
  expect(shifted / pixels, "the workload left the map where it found it").toBeGreaterThan(0.2);

  const sorted = [...samples.deltas].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const p95 = quantile(sorted, 0.95);
  // A refresh period taken from the run itself, not assumed to be 60 Hz: a 120 Hz display would
  // make an absolute 16.7 ms bar count every ordinary frame as a miss.
  const missed = sorted.filter((delta) => delta > median * 1.5).length;
  const overTwoFrames = sorted.filter((delta) => delta > median * 2).length;

  const baseline = {
    fixture: "full stack — terrain + hillshade + contours + marks, 5,400-point recording",
    url: FULL_STACK.replace(ARCHIVES, "<archives>"),
    browser: version.product,
    protocol: version.protocolVersion,
    platform: process.platform,
    playwright: PLAYWRIGHT_VERSION,
    // **The rasteriser, because it decides these numbers.** A headless browser may fall back to
    // software rendering, and a frame cadence measured on one is a baseline for this harness
    // rather than a claim about what a person with a GPU sees.
    webgl: renderer,
    viewport: "1280×720 @ DPR 1",
    warmUp: `render settled in ${String(settled.elapsedMs)} ms, then ${String(WARM_UP_FRAMES)} frames discarded`,
    workload: `${String(WORKLOAD.reduce((n, [, presses]) => n + presses, 0))} key presses at ${String(PRESS_INTERVAL_MS)} ms`,
    frameDelivery: {
      note: "delivered-frame interval during the workload — NOT render duration",
      samples: samples.deltas.length,
      windowMs: Math.round(samples.durationMs),
      medianMs: +median.toFixed(2),
      p95Ms: +p95.toFixed(2),
      maxMs: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
      overOneAndAHalfMedian: missed,
      overTwoMedian: overTwoFrames,
    },
    longAnimationFrames: samples.loafSupported
      ? {
          note: "frames over 50 ms; their absence says nothing about ordinary render cost",
          count: samples.loaf.length,
          durationsMs: samples.loaf.map((entry) => +entry.duration.toFixed(1)).slice(0, 20),
        }
      : "unsupported in this browser",
    memory: {
      pageTotal: memory.standardApi === "function" ? "measured" : "unavailable",
      why:
        memory.standardApi === "function"
          ? "measureUserAgentSpecificMemory is available"
          : `measureUserAgentSpecificMemory needs cross-origin isolation; crossOriginIsolated=${String(memory.crossOriginIsolated)}. performance.memory is deprecated and not used.`,
      jsHeapNote:
        "CDP Performance.getMetrics JSHeapUsedSize after a forced collection. JS heap only — " +
        "GPU, texture and renderer memory are excluded, and for a WebGL map that is most of it.",
      jsHeapBeforeBytes: before,
      jsHeapAfterBytes: after,
      jsHeapPeakBytes:
        "not measured — sampling during the workload would perturb the frame timing it shares a run with",
    },
    workloadMovedPixels: `${String(shifted)} of ${String(pixels)} — the positive control, not a score`,
  };

  console.log(`BASELINE ${JSON.stringify(baseline, null, 2)}`);

  // Non-vacuity, and nothing else. No threshold: the numbers above are observations, and a bar
  // set from this machine would be a guess that a future failure could not explain.
  expect(Number.isFinite(before) && Number.isFinite(after), "no heap figure was read").toBe(true);
});
