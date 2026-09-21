// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from "node:fs";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CERTIFICATE_ENV,
  RUNTIME_MODES,
  RUNTIME_MODE_ENV,
  SELFTEST_ENV,
  SELFTEST_MIXED,
} from "./flake-experiment.mjs";
import { SIGNATURE } from "./flake-probe.mjs";

/**
 * **Every run of the suite certifies which runtime mode its worker was in** (T8.1 increments 2c
 * and 2d).
 *
 * The experiment's two arms spawn the identical `npm run test:coverage` and differ only by a
 * marker in the child's environment, which `vitest.config.ts` turns into the workers' `execArgv`.
 * That translation is exactly the kind that fails silently: an earlier attempt used Vitest's
 * obsolete `poolOptions.forks.execArgv`, which 4.1.11 discards — the suite passed, the worker ran
 * default Node, and every assertion over the *constructed* environment was still green. Two arms
 * silently running the same mode would produce a null the design would read as "no difference".
 *
 * So the check is inside the worker, on what the worker actually got, and it runs in every run of
 * the suite the experiment measures. A variant run whose marker arrived while the flag did not
 * fails *here* — which makes that arm contaminated and the experiment inconclusive, rather than
 * letting it be counted as a comparison between an arm and itself.
 *
 * **What it cannot see is a marker that never arrived.** It compares the worker's own environment
 * against the worker's own flags: no marker and no flag agree with each other, and a variant run
 * whose environment went astray is green in here. Only the runner knows which arm it scheduled, so
 * when it names a certificate path the facts are written there as well, and `spawn-arm.mjs` hands
 * them back to be judged against the arm — `certificateProblems`. A run that leaves no certificate
 * is an instrument failure.
 *
 * Unmarked — every ordinary run, local and CI — it asserts the ordinary thing: no flag, and
 * WebAssembly present, and writes nothing.
 */
const intendedFlags = RUNTIME_MODES[process.env[RUNTIME_MODE_ENV]] ?? [];
/** Every flag any arm adds: each is asserted present or absent, never merely not-looked-for. */
const everyArmsFlags = [...new Set(Object.values(RUNTIME_MODES).flat())];

it("runs its worker in the runtime mode the marker asked for", () => {
  // Written before anything is asserted, and whatever the assertions then say: the runner judges
  // these facts against the arm it scheduled, which this worker has no way to know.
  const certificatePath = process.env[CERTIFICATE_ENV];
  if (certificatePath !== undefined) {
    writeFileSync(
      certificatePath,
      JSON.stringify({
        marker: process.env[RUNTIME_MODE_ENV],
        // **Verbatim and whole.** Which runtime this worker was *started as* is a property of the
        // entire list, order included — `--no-opt --opt` turns TurboFan back on — so nothing is
        // picked out of it here. The runner holds the list against the arm; see
        // `certificateProblems`.
        execArgv: process.execArgv,
        nodeOptions: process.env.NODE_OPTIONS ?? null,
        wasm: typeof WebAssembly,
      }),
    );
  }

  // What this worker can check about itself, which is less than the runner checks: only that the
  // flags of the arm its marker names are here and the other arms' are not.
  for (const flag of everyArmsFlags) {
    expect(process.execArgv.includes(flag), flag).toBe(intendedFlags.includes(flag));
  }
  // The observable consequence, not a second reading of the same flag: `--jitless` removes
  // WebAssembly, which is why it cannot be applied to the Vite parent. `--no-opt` has no
  // consequence a worker can see without `--allow-natives-syntax`, which must never be in a
  // measured arm; what it *means* is established by `check-runtime-mode.mjs` instead.
  expect(typeof WebAssembly === "undefined").toBe(intendedFlags.includes("--jitless"));
});

/**
 * **A run that fails every way the tally has got wrong, at once, on request, and never
 * otherwise.** Registered only when `check-runtime-mode.mjs` asks for it, so an ordinary or a
 * measured run collects exactly the one test above and its counts are untouched; the runner
 * refuses to start with this inherited. The production modules are imported *inside* the branch
 * for the same reason: a measured run never loads them on this file's account.
 *
 * The check reads what `probe-results-reporter.mjs` wrote for this run and requires each failure
 * below to be accounted for — the two clean hits left alone, and every other one named:
 *
 * - **The recorded failure, raised by production**, in both forms it has: as `stitchSurface` throws
 *   it, and as `BuildError` reports it from the tiles stage, which is how a real build fails. A
 *   structured check that demanded the bare signature would contaminate every genuine hit.
 * - **An unrelated test**, and **an unrelated `describe`-level hook** — for which Vitest's own JSON
 *   reporter records nothing at all.
 * - **The recorded failure and an unrelated error on the *same test*.** Vitest attaches a
 *   teardown's error to the test it ran after, so the two arrive as one entry with two messages,
 *   and clearing the entry on *some* message cleared both (shown in review).
 * - **An error that only *carries* the signature**: behind an arbitrary prefix, and on a later
 *   line. The log calls both a hit, and they stay hits; neither is the recorded failure, and an
 *   end-anchored match let both through as clean hits (shown in review).
 */
if (process.env[SELFTEST_ENV] === SELFTEST_MIXED) {
  const { BuildError } = await import("./fixture/build.mjs");
  const { stitchSurface } = await import("./fixture/surface.mjs");

  /** 46x113 with 35x113 laid over it: no gap, 35 x 113 = 3955 written twice — the recorded numbers. */
  const stitchTheRecordedOverlap = () => {
    const crop = (width, height) => ({
      width,
      height,
      west: 7,
      north: 45.9,
      pixelScaleDeg: 1 / 3600,
      rgb: new Uint8Array(width * height * 3),
    });
    stitchSurface([crop(46, 113), crop(35, 113)]);
  };

  describe("self-test: the recorded failure, raised by production", () => {
    it("clean hit: as stitchSurface throws it", () => {
      stitchTheRecordedOverlap();
    });
    it("clean hit: as the build reports it, from the tiles stage", () => {
      try {
        stitchTheRecordedOverlap();
      } catch (error) {
        throw new BuildError("tiles", error);
      }
    });
  });

  describe("self-test: an unrelated test", () => {
    it("contaminates: fails for a reason that is not the recorded one", () => {
      expect("an unrelated failure").toBe("the recorded failure");
    });
  });

  describe("self-test: the recorded failure beside a teardown error", () => {
    afterEach(() => {
      throw new Error("an unrelated failure in a teardown, attached to the test it ran after");
    });
    it("contaminates: the recorded failure, and then its teardown fails too", () => {
      stitchTheRecordedOverlap();
    });
  });

  describe("self-test: an error that only carries the signature", () => {
    it("contaminates: an arbitrary prefix before the signature", () => {
      throw new Error(`rebuild failed: ${SIGNATURE}`);
    });
    it("contaminates: the signature on a later line", () => {
      throw new Error(`cleanup failed after:\n${SIGNATURE}`);
    });
  });

  describe("self-test: an unrelated hook", () => {
    beforeAll(() => {
      throw new Error(
        "contaminates: an unrelated failure in a hook, which leaves its tests skipped",
      );
    });
    it("never runs", () => {});
  });
}
