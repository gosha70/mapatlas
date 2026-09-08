// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { assertPortFree, demoUrl, startDemo, waitForApp } from "./demo.mjs";

/**
 * The orchestration, with every side effect injected.
 *
 * What this pins is **order and readiness** — the two things that make `npm run demo` either one
 * command or a trap. Neither is visible from a successful run on a machine that already has
 * everything built.
 */

/** A stand-in for the vite child process. */
const child = () => {
  const emitter = new EventEmitter();
  emitter.kill = () => {
    emitter.killed = true;
  };
  emitter.killed = false;
  return emitter;
};

const harness = (over = {}) => {
  const calls = [];
  const app = over.app ?? child();
  const archives = { closed: false, close: () => (archives.closed = true) };
  const deps = {
    run: async (command, args) => {
      calls.push(`run:${command} ${args.join(" ")}`);
    },
    serve: async () => {
      calls.push("serve:archives");
      return archives;
    },
    spawnApp: () => {
      calls.push("spawn:app");
      return app;
    },
    ready: async () => {
      calls.push("ready:awaited");
    },
    probe: async () => true,
    archivePresent: () => true,
    checkAppPort: async () => undefined,
    out: () => undefined,
    ...over.deps,
  };
  return { calls, deps, app, archives };
};

describe("startDemo", () => {
  it("builds the packages before starting anything", async () => {
    // **The clean-start bug this pins.** Vite resolves every @mapatlas import to a built `dist`
    // that `npm install` does not create and git does not track. Without this step a fresh clone
    // fails on an unresolvable import; the run that "worked" had inherited `dist` from earlier
    // verification.
    const { calls, deps } = harness();

    await startDemo(deps);

    expect(calls[0]).toBe("run:npm run build");
    expect(calls.indexOf("run:npm run build")).toBeLessThan(calls.indexOf("spawn:app"));
  });

  it("builds every time, not only when the archives are missing", async () => {
    // A stale `dist` demonstrates yesterday's source while looking entirely current, so "build
    // if absent" is not enough. `tsc --build` is incremental; always running it costs a second.
    const { calls, deps } = harness({ deps: { archivePresent: () => true } });

    await startDemo(deps);

    expect(calls.filter((c) => c === "run:npm run build")).toHaveLength(1);
  });

  it("cuts the archives only when one is missing", async () => {
    const present = harness();
    await startDemo(present.deps);
    expect(present.calls.some((c) => c.includes("build-fixture"))).toBe(false);

    const absent = harness({ deps: { archivePresent: () => false } });
    await startDemo(absent.deps);
    expect(absent.calls.some((c) => c.includes("build-fixture"))).toBe(true);
  });

  it("announces nothing while readiness is still pending, and the URL once it settles", async () => {
    // **Observed, not inferred.** An injected `ready` that resolves immediately proves only that
    // it was called and that a URL eventually appeared — an implementation announcing *before*
    // awaiting it would satisfy that just as well. Holding readiness open is what separates the
    // two: the window where the app is not yet listening is exactly the window a customer would
    // be handed a dead link in.
    const printed = [];
    let letReadyFinish;
    const pending = new Promise((settle) => {
      letReadyFinish = settle;
    });
    const { calls, deps } = harness({
      deps: { out: (text) => printed.push(text), ready: () => pending },
    });

    const starting = startDemo(deps);
    // Let everything up to the wait run, then look: the app is spawned and nothing is announced.
    await Promise.resolve();
    await new Promise((tick) => setTimeout(tick, 0));

    expect(calls).toContain("spawn:app");
    expect(printed.join(""), "a URL was announced before the app was ready").not.toContain("Open:");

    letReadyFinish();
    await starting;

    expect(printed.join("")).toContain(demoUrl());
  });

  it("prints nothing and frees both ports when the app never becomes ready", async () => {
    // **The failure that would poison the next attempt.** Leaving the archive port bound makes
    // the following run fail for a different reason, and its message blames the wrong thing.
    const printed = [];
    const { deps, app, archives } = harness({
      deps: {
        out: (text) => printed.push(text),
        ready: async () => {
          throw new Error("the app exited (1) before it was ready");
        },
      },
    });

    await expect(startDemo(deps)).rejects.toThrow(/before it was ready/);
    expect(printed.join(""), "a URL was announced for an app that never started").not.toContain(
      "Open:",
    );
    expect(archives.closed, "the archive port was left bound").toBe(true);
    expect(app.killed).toBe(true);
  });
});

describe("waitForApp", () => {
  it("returns once the app answers, having tolerated it not being ready at first", async () => {
    let attempts = 0;
    const probe = async () => {
      attempts += 1;
      return attempts >= 3;
    };

    await expect(waitForApp(child(), probe, { attempts: 10, pause: 1 })).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });

  it("fails as soon as the app exits, rather than polling a process that is gone", async () => {
    // An occupied port is the common case: vite prints its own error and exits, and without this
    // race the loop would poll a dead process until it timed out with an unrelated message.
    const app = child();
    const waiting = waitForApp(app, async () => false, { attempts: 100, pause: 1 });
    app.emit("exit", 1);

    await expect(waiting).rejects.toThrow(/exited \(1\) before it was ready/);
  });

  it("fails on a spawn error, which otherwise has no listener at all", async () => {
    const app = child();
    const waiting = waitForApp(app, async () => false, { attempts: 100, pause: 1 });
    app.emit("error", new Error("npx not found"));

    await expect(waiting).rejects.toThrow(/npx not found/);
  });

  it("gives up rather than waiting forever", async () => {
    await expect(waitForApp(child(), async () => false, { attempts: 2, pause: 1 })).rejects.toThrow(
      /did not answer/,
    );
  });
});

describe("the readiness must belong to this launch", () => {
  it("refuses to start when something already holds the app port", async () => {
    // **The incumbent.** Vite runs with --strictPort, so an existing server makes the child exit
    // while that incumbent keeps answering 200. Without this check the runner sees a healthy
    // probe and hands someone a page served by a process it neither owns nor can stop.
    const printed = [];
    const { deps, calls, archives } = harness({
      deps: {
        out: (text) => printed.push(text),
        checkAppPort: async () => {
          throw new Error("port 5175 is already in use, so the app cannot start there.");
        },
      },
    });

    await expect(startDemo(deps)).rejects.toThrow(/already in use/);
    expect(printed.join(""), "a URL was announced for someone else's server").not.toContain(
      "Open:",
    );
    // Checked before anything is bound, so there is nothing to release.
    expect(calls).not.toContain("serve:archives");
    expect(calls).not.toContain("spawn:app");
    expect(archives.closed).toBe(false);
  });

  it("refuses a successful probe when the child has already died", async () => {
    // The exact ordering bug: returning from a truthy probe skipped the failure check, so a
    // probe answered by an incumbent while our child exited reported ready.
    const app = child();
    const probe = async () => {
      app.emit("exit", 1);
      return true;
    };

    await expect(waitForApp(app, probe, { attempts: 5, pause: 1 })).rejects.toThrow(
      /exited \(1\) before it was ready/,
    );
  });
});

describe("assertPortFree", () => {
  it("resolves for a port nothing holds", async () => {
    await expect(assertPortFree(0)).resolves.toBeUndefined();
  });

  it("releases the port it tested, since the app is about to listen on it", async () => {
    // **Port 0 cannot show this.** The OS picks a fresh port each time, so a check that never
    // released would still resolve twice and look correct. A *named* port called twice is what
    // proves the probe let go — and if it did not, the app would be refused the very port this
    // check just declared free.
    const { serveArchives } = await import("./serve-archives.mjs");
    const borrowed = await serveArchives({ dir: ".", port: 0 });
    const port = borrowed.address().port;
    await new Promise((closed) => borrowed.close(closed));

    await expect(assertPortFree(port)).resolves.toBeUndefined();
    await expect(
      assertPortFree(port),
      "the probe kept the port it tested",
    ).resolves.toBeUndefined();
  });

  it("reports an occupied port in words someone can act on", async () => {
    const { serveArchives } = await import("./serve-archives.mjs");
    const held = await serveArchives({ dir: ".", port: 0 });
    const port = held.address().port;

    await expect(assertPortFree(port)).rejects.toThrow(/already in use.*run the command again/s);
    held.close();
  });
});
