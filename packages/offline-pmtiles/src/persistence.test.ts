// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  installGuidance,
  isStoragePersisted,
  requestPersistentStorage,
} from "./persistence";

describe("requestPersistentStorage", () => {
  it("returns the browser's grant decision", async () => {
    const nav = { storage: { persist: () => Promise.resolve(true) } };
    expect(await requestPersistentStorage(nav)).toBe(true);
  });

  it("returns false when unsupported", async () => {
    expect(await requestPersistentStorage({})).toBe(false);
    expect(await requestPersistentStorage(undefined)).toBe(false);
  });

  it("returns false when the call throws", async () => {
    const nav = {
      storage: {
        persist: () => Promise.reject(new Error("nope")),
      },
    };
    expect(await requestPersistentStorage(nav)).toBe(false);
  });
});

describe("isStoragePersisted", () => {
  it("reflects the persisted state", async () => {
    const nav = { storage: { persisted: () => Promise.resolve(true) } };
    expect(await isStoragePersisted(nav)).toBe(true);
    expect(await isStoragePersisted({})).toBe(false);
  });
});

describe("installGuidance", () => {
  it("gives iOS/Safari home-screen steps", () => {
    const g = installGuidance(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari",
    );
    expect(g.platform).toBe("ios");
    expect(g.steps.join(" ")).toContain("Add to Home Screen");
    expect(g.reason).toContain("persistent storage");
  });

  it("gives Android install steps", () => {
    const g = installGuidance("Mozilla/5.0 (Linux; Android 14) Chrome");
    expect(g.platform).toBe("android");
    expect(g.steps.length).toBeGreaterThan(0);
  });

  it("falls back to desktop guidance", () => {
    const g = installGuidance("Mozilla/5.0 (Windows NT 10.0) Chrome");
    expect(g.platform).toBe("desktop");
  });
});
