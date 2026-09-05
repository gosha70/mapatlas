// SPDX-License-Identifier: Apache-2.0

/**
 * `/`'s installation guidance (T6.2, increment 2).
 *
 * **Static text. Nothing here detects, triggers, or advertises installability.** No
 * `beforeinstallprompt` — it is non-standard, Chromium-only and absent on iOS, so a control
 * built on it would work for some readers and silently not exist for the ones this guidance is
 * most for. No manifest, icons or service worker either: making the demo itself installable is
 * T7.1's criterion, not this one's.
 *
 * The guidance exists because installing changes something real about storage, and the change is
 * easy to get backwards.
 */

/** One step of the guidance. Kept as data so a test can assert order and wording. */
export interface InstallStep {
  readonly title: string;
  readonly detail: string;
}

/**
 * The steps, **in the order they have to be done**.
 *
 * The ordering is the whole point rather than a presentational choice. On iOS a Home Screen web
 * app's data is *"kept isolated from Safari"*, and since iOS/iPadOS 17.2 installation copies
 * cookies and nothing else — *"No other kind of local storage is copied over"*. A region
 * downloaded in the browser therefore does **not** follow the app onto the Home Screen: the
 * installed app opens on an empty store and has to download it again.
 *
 * So guidance shaped as "download a region, then add it to your Home Screen" tells the reader to
 * throw away the download they just waited for. Install first.
 *
 * **The isolation is scoped to where it holds, and the order is not.** On Chromium — desktop and
 * Android — an installed app shares the browser profile's origin storage, so a region downloaded
 * in the tab *is* there in the installed app. Stating the isolation flatly would tell those
 * readers something false about their own data, which is the exact failure this guidance exists
 * to avoid. The *order* stays universal: it is essential where the stores are separate and
 * harmless where they are shared, so there is no reader for whom it is wrong.
 */
export const INSTALL_STEPS: readonly InstallStep[] = Object.freeze([
  Object.freeze({
    title: "Install first, before downloading anything",
    detail:
      "On iPhone and iPad an installed app keeps its own separate storage, so anything " +
      "downloaded in the browser beforehand — including map regions — is not carried across, " +
      "and installing afterwards means downloading it again. Elsewhere the installed app " +
      "usually shares the browser's storage, so installing first costs you nothing either way.",
  }),
  Object.freeze({
    title: "Add this site to your home screen or dock",
    detail:
      "Open your browser's share or menu affordance and choose the option to add this site to " +
      "your home screen, or to install it. Where the option lives differs between browsers, and " +
      "on iPhone and iPad it is always a manual step — no site can trigger it for you.",
  }),
  Object.freeze({
    title: "Open the installed app, then download and request persistence there",
    detail:
      "Download your regions from inside the installed app, and ask for persistent storage " +
      "there too. On iPhone and iPad that store is separate from the browser's, so neither the " +
      "download nor the request carries over from one to the other.",
  }),
]);

/**
 * What installing actually buys — and the one thing it does not.
 *
 * The "not" is here because it is the plausible-sounding wrong answer. Safari **already** has
 * the browser-app quota, and a Home Screen web app gets *"the same origin quota and overall
 * quota as when it is opened in a browser app"*. The much smaller figure belongs to non-browser
 * apps embedding a web view, which is not what installing produces.
 */
export const INSTALL_BENEFIT =
  "On iPhone and iPad, an installed app's data is not subject to the seven-day inactivity " +
  "clean-up that applies to sites you have not opened recently, and a request for persistent " +
  "storage is more likely to be granted there.";

export const INSTALL_NON_BENEFIT =
  "Installing does not give the app more space than the browser already has.";

/** Render the guidance. Returns the element, so a caller can place it. */
export function mountInstallGuidance(container: HTMLElement): HTMLElement {
  const section = document.createElement("section");
  section.id = "install-guidance";

  const heading = document.createElement("h2");
  heading.textContent = "Keeping downloaded maps on a phone";
  section.append(heading);

  // An ordered list, because the order is the content. A reader who takes these in any other
  // sequence downloads a region twice.
  const steps = document.createElement("ol");
  for (const step of INSTALL_STEPS) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = step.title;
    const detail = document.createElement("p");
    detail.textContent = step.detail;
    item.append(title, detail);
    steps.append(item);
  }
  section.append(steps);

  const benefit = document.createElement("p");
  benefit.className = "install-benefit";
  benefit.textContent = `${INSTALL_BENEFIT} ${INSTALL_NON_BENEFIT}`;
  section.append(benefit);

  container.append(section);
  return section;
}
