// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";

import {
  INSTALL_BENEFIT,
  INSTALL_NON_BENEFIT,
  INSTALL_STEPS,
  mountInstallGuidance,
} from "./install-guidance.js";

/**
 * Guidance is text, so what is testable is what the text **claims** — and every assertion below
 * exists because the opposite claim is the plausible one someone would write.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const host = (): HTMLElement => {
  const element = document.createElement("main");
  document.body.append(element);
  return element;
};

const textOf = (root: HTMLElement): string => root.textContent ?? "";

describe("the order is the content", () => {
  it("tells the reader to install before downloading, not after", async () => {
    // The failure this prevents: an installed app's storage is isolated and installation copies
    // cookies only, so a region downloaded in the browser first is not carried across. Guidance
    // in the other order tells someone to throw away the download they waited for.
    const first = INSTALL_STEPS[0];
    expect(first?.title, "the first step is not about installing first").toMatch(/install first/i);
    expect(first?.detail).toMatch(/not carried across|downloading it again/i);

    // **And the reason is scoped to where it is true.** Storage isolation is a WebKit behaviour:
    // on Chromium — desktop and Android — an installed app shares the browser profile's origin
    // storage, so a region downloaded in the tab *is* there afterwards. Stating the isolation
    // flatly would tell those readers something false about their own data. The order stays
    // universal because it is essential where the stores are separate and harmless where they
    // are not; only the reason needs a platform on it.
    expect(
      first?.detail,
      "the isolation claim is stated as universal when it is a platform behaviour",
    ).toMatch(/iphone and ipad/i);
  });

  it("puts downloading and requesting persistence in the installed app, last", () => {
    const last = INSTALL_STEPS[INSTALL_STEPS.length - 1];
    expect(last?.title).toMatch(/installed app/i);
    expect(last?.detail).toMatch(/download/i);
    expect(last?.detail).toMatch(/persistent storage/i);
  });

  it("renders the steps as an ordered list, in the order they must be done", () => {
    // A `<ul>` would say the steps are interchangeable, which is the one thing they are not.
    const root = host();
    const section = mountInstallGuidance(root);

    const list = section.querySelector("ol");
    expect(list, "the steps are not an ordered list").not.toBeNull();
    const rendered = [...(list?.querySelectorAll("li") ?? [])].map(
      (item) => item.textContent ?? "",
    );
    expect(rendered).toHaveLength(INSTALL_STEPS.length);
    for (const [index, step] of INSTALL_STEPS.entries()) {
      expect(rendered[index], `step ${String(index + 1)} is out of order`).toContain(step.title);
    }
  });
});

describe("what installing is said to buy", () => {
  it("states the retention and grant benefits", () => {
    expect(INSTALL_BENEFIT).toMatch(/seven-day|7-day/i);
    expect(INSTALL_BENEFIT).toMatch(/more likely to be granted/i);
  });

  it("says installing does not buy more space", () => {
    // The plausible wrong answer, and it is wrong twice over: Safari already has the browser-app
    // quota, and an installed app gets the same one rather than a larger one. The smaller figure
    // people remember belongs to non-browser apps embedding a web view.
    expect(INSTALL_NON_BENEFIT).toMatch(/does not give.*more space/i);

    // Asserted as *present in the rendered text*, not as a pattern absent from it. An earlier
    // version tried `/more space/` with a negative lookahead for "does not" — which cannot work,
    // because the negation comes *before* the phrase it negates, and a lookahead only sees
    // forward. Requiring the sentence is the claim that actually holds: drop it and this fails.
    const root = host();
    mountInstallGuidance(root);
    expect(textOf(root), "the guidance never says installing buys no extra space").toContain(
      INSTALL_NON_BENEFIT,
    );
  });

  it("never claims a bigger quota anywhere in the rendered text", () => {
    const root = host();
    mountInstallGuidance(root);
    const words = textOf(root);

    for (const claim of [/larger quota/i, /bigger quota/i, /increases? (the )?quota/i]) {
      expect(words, `the guidance claims a quota increase: ${String(claim)}`).not.toMatch(claim);
    }
  });
});

describe("what the guidance deliberately does not do", () => {
  it("names no browser and no version", () => {
    // Safari 26 removed installability requirements entirely, so an enumerated list dates on
    // contact — and the affordance's location is the browser's to move, not this demo's to pin.
    const root = host();
    mountInstallGuidance(root);
    const words = textOf(root);

    for (const named of [/chrome/i, /safari/i, /firefox/i, /edge/i, /\bios \d/i, /version \d/i]) {
      expect(words, `the guidance names a browser or version: ${String(named)}`).not.toMatch(named);
    }
  });

  it("says installation is manual rather than offering to do it", () => {
    // No `beforeinstallprompt`: it is non-standard, Chromium-only and absent on iOS, so a button
    // built on it would silently not exist for the readers this guidance is most for.
    const root = host();
    const section = mountInstallGuidance(root);

    expect(section.querySelector("button"), "the guidance offers to install").toBeNull();
    expect(textOf(root)).toMatch(/manual step|no site can trigger it/i);
  });
});
