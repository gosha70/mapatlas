// SPDX-License-Identifier: Apache-2.0

/**
 * T6.2 acceptance: persistence request + install guidance behave across
 * environments (supported / denied / unsupported) and platforms.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectPlatform,
  estimateStorage,
  installPromptGuidance,
  requestPersistentStorage,
} from "./persistence.js";

afterEach(() => vi.unstubAllGlobals());

describe("requestPersistentStorage", () => {
  it("returns 'unsupported' when the API is missing", async () => {
    vi.stubGlobal("navigator", {});
    expect(await requestPersistentStorage()).toBe("unsupported");
  });

  it("short-circuits to 'persisted' when already persisted", async () => {
    const persist = vi.fn();
    vi.stubGlobal("navigator", {
      storage: { persisted: async () => true, persist },
    });
    expect(await requestPersistentStorage()).toBe("persisted");
    expect(persist).not.toHaveBeenCalled();
  });

  it("maps persist() true/false to persisted/denied", async () => {
    vi.stubGlobal("navigator", {
      storage: { persisted: async () => false, persist: async () => true },
    });
    expect(await requestPersistentStorage()).toBe("persisted");

    vi.stubGlobal("navigator", {
      storage: { persisted: async () => false, persist: async () => false },
    });
    expect(await requestPersistentStorage()).toBe("denied");
  });
});

describe("estimateStorage", () => {
  it("returns the estimate when available, else undefined", async () => {
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ usage: 10, quota: 100 }) },
    });
    expect(await estimateStorage()).toEqual({ usage: 10, quota: 100 });

    vi.stubGlobal("navigator", {});
    expect(await estimateStorage()).toBeUndefined();
  });
});

describe("detectPlatform + installPromptGuidance", () => {
  it("detects iOS Safari and gives Add-to-Home-Screen guidance", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
    expect(detectPlatform(ua)).toBe("ios-safari");
    expect(installPromptGuidance("ios-safari")).toMatch(/Home Screen/i);
  });

  it("detects Android", () => {
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14)")).toBe("android");
    expect(installPromptGuidance("android")).toMatch(/install/i);
  });

  it("detects desktop", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0)")).toBe("desktop");
  });

  it("falls back to generic guidance", () => {
    expect(installPromptGuidance("unknown")).toMatch(/home screen/i);
  });
});
