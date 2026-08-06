// SPDX-License-Identifier: Apache-2.0

/**
 * Storage-persistence helpers (T6.2). On mobile browsers, offline tiles and user
 * data can be evicted under storage pressure unless the origin is granted
 * *persistent* storage — which itself usually requires the app be installed to
 * the home screen. These helpers let a consumer request persistence and surface
 * install guidance; the demo wires them into its UI.
 *
 * `navigator` is read through an injectable parameter so the helpers are testable
 * without a browser (and stay usable under SSR by returning safe defaults).
 */

interface StorageManagerLike {
  persist?(): Promise<boolean>;
  persisted?(): Promise<boolean>;
}
interface NavigatorLike {
  storage?: StorageManagerLike;
  userAgent?: string;
}

function ambientNavigator(): NavigatorLike | undefined {
  return typeof navigator !== "undefined"
    ? (navigator as NavigatorLike)
    : undefined;
}

/**
 * Ask the browser to make this origin's storage persistent (eviction-resistant).
 * Resolves `false` where unsupported. Must be called from a user gesture on
 * some browsers.
 */
export async function requestPersistentStorage(
  nav: NavigatorLike | undefined = ambientNavigator(),
): Promise<boolean> {
  const persist = nav?.storage?.persist;
  if (!persist) return false;
  try {
    return await persist.call(nav.storage);
  } catch {
    return false;
  }
}

/** Whether storage is already persistent. `false` where unsupported. */
export async function isStoragePersisted(
  nav: NavigatorLike | undefined = ambientNavigator(),
): Promise<boolean> {
  const persisted = nav?.storage?.persisted;
  if (!persisted) return false;
  try {
    return await persisted.call(nav.storage);
  } catch {
    return false;
  }
}

export type InstallPlatform = "ios" | "android" | "desktop";

export interface InstallGuidance {
  platform: InstallPlatform;
  /** Why installing matters, then the steps to do it. */
  reason: string;
  steps: string[];
}

const REASON =
  "Install this app to your home screen and allow persistent storage so " +
  "downloaded maps and your logged events are not evicted when storage is low.";

/**
 * Platform-appropriate "add to home screen" guidance, chosen from the
 * user-agent string. iOS especially requires an installed PWA before
 * `storage.persist()` is honoured.
 */
export function installGuidance(
  userAgent: string | undefined = ambientNavigator()?.userAgent,
): InstallGuidance {
  const ua = (userAgent ?? "").toLowerCase();
  if (
    /iphone|ipad|ipod/.test(ua) ||
    (/macintosh/.test(ua) && /mobile/.test(ua))
  ) {
    return {
      platform: "ios",
      reason: REASON,
      steps: [
        "Open this page in Safari.",
        "Tap the Share button.",
        "Choose “Add to Home Screen”.",
        "Launch the app from the new home-screen icon.",
      ],
    };
  }
  if (/android/.test(ua)) {
    return {
      platform: "android",
      reason: REASON,
      steps: [
        "Open this page in Chrome.",
        "Open the browser menu (⋮).",
        "Choose “Install app” / “Add to Home screen”.",
      ],
    };
  }
  return {
    platform: "desktop",
    reason: REASON,
    steps: [
      "Open this page in a Chromium-based browser.",
      "Click the install icon in the address bar (or the menu → “Install”).",
    ],
  };
}
