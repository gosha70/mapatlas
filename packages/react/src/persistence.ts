// SPDX-License-Identifier: Apache-2.0

/**
 * Storage-persistence helpers (tasks T6.2).
 *
 * Offline map regions and user data live in IndexedDB, which browsers may evict
 * under storage pressure — especially on iOS unless the app is installed to the
 * home screen. These helpers let a consumer request durable storage and surface
 * install guidance. The demo wires them into its UI (T7.2).
 *
 * They touch only `navigator` (never `window`/`document` at import) and degrade
 * gracefully where the APIs are unavailable.
 */

export type PersistResult = "persisted" | "denied" | "unsupported";

/**
 * Ask the browser to make storage persistent (survives eviction). Idempotent:
 * if already persisted, resolves to `"persisted"` without re-prompting.
 */
export async function requestPersistentStorage(): Promise<PersistResult> {
  const storage =
    typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!storage || typeof storage.persist !== "function") return "unsupported";
  try {
    if (typeof storage.persisted === "function") {
      const already = await storage.persisted();
      if (already) return "persisted";
    }
    const ok = await storage.persist();
    return ok ? "persisted" : "denied";
  } catch {
    return "unsupported";
  }
}

/** A rough estimate of used/quota bytes, when the browser exposes it. */
export async function estimateStorage(): Promise<StorageEstimate | undefined> {
  const storage =
    typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!storage || typeof storage.estimate !== "function") return undefined;
  try {
    return await storage.estimate();
  } catch {
    return undefined;
  }
}

/** Coarse platform guess used to pick the right install guidance copy. */
export type Platform = "ios-safari" | "android" | "desktop" | "unknown";

export function detectPlatform(ua?: string): Platform {
  const s = (
    ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")
  ).toLowerCase();
  if (!s) return "unknown";
  const isIOS =
    /iphone|ipad|ipod/.test(s) ||
    // iPadOS reports as Mac but is touch-capable
    (/macintosh/.test(s) &&
      typeof navigator !== "undefined" &&
      (navigator.maxTouchPoints ?? 0) > 1);
  if (isIOS) return "ios-safari";
  if (/android/.test(s)) return "android";
  if (/windows|macintosh|linux|cros/.test(s)) return "desktop";
  return "unknown";
}

/**
 * Human-readable guidance for installing the app to the home screen so the OS
 * grants durable storage (chiefly for iOS, where `persist()` alone is unreliable).
 */
export function installPromptGuidance(platform?: Platform): string {
  switch (platform ?? detectPlatform()) {
    case "ios-safari":
      return "To keep your maps and logs offline, add this app to your Home Screen: tap the Share button, then “Add to Home Screen”. iOS may otherwise clear stored data.";
    case "android":
      return "For reliable offline use, install this app: open the browser menu and choose “Install app” (or “Add to Home screen”).";
    case "desktop":
      return "Install this app from your browser’s address-bar install icon to keep offline maps and logs available.";
    default:
      return "Install this app to your device (add to home screen) to keep offline maps and logs from being cleared.";
  }
}
