// SPDX-License-Identifier: Apache-2.0

/**
 * The demo's persistence control (T6.2).
 *
 * **What it is for.** An origin's storage is *best-effort* by default: under storage pressure a
 * browser evicts least-recently-used origins, and it takes an origin's data **together** —
 * downloaded regions and recorded trips alike. `navigator.storage.persist()` asks to be excluded
 * from that. It is the only thing that grants the exclusion, and the engine cannot call it on a
 * consumer's behalf, so the demo shows a consumer what the call looks like.
 *
 * **What it is not.** Not a guarantee, and the control must never read as one. The request may be
 * denied — silently, and *commonly*, in Chromium, which decides on engagement heuristics without
 * prompting. A denial is a normal answer, not a failure.
 *
 * Installation guidance is increment 2, and lives elsewhere: this file contains no manifest, no
 * service worker, and nothing resembling `beforeinstallprompt`.
 */

/**
 * The two methods this control uses from `navigator.storage`.
 *
 * **Internal to the demo. Not an engine interface, and not published anywhere.** It exists
 * because any one run reaches one outcome: the browser answers granted *or* denied, and the
 * profile the browser lane runs on supports the API and does not reject, so it never reaches
 * `unsupported` or `error` naturally. Those states are real — a browser without the methods, or
 * a call that fails rather than refuses, produces each of them — but nothing in this repo's
 * lanes will produce them on demand. Without a seam they would be unexercised code rendering
 * whatever it happened to render. Stubbing `navigator.storage` globally would reach the same
 * branches and mutate a global the rest of the page shares.
 */
export interface PersistenceApi {
  persisted(): Promise<boolean>;
  persist(): Promise<boolean>;
}

/**
 * What the control is showing: **five platform outcomes plus two control states.**
 *
 * The outcomes are what a browser can tell us — `already-persistent`, `granted`, `denied`,
 * `unsupported`, `error` — and each has to be distinguishable from the others: "denied" and
 * "unsupported" are different facts about the user's browser, and reading an "error" as a denial
 * would tell someone their browser refused when it never answered.
 *
 * The other two are this control's own. `checking` is the interval before `persisted()` has
 * answered, and **nothing may be requested from it**: without it the button is live while the
 * status is still in flight, so a fast activation can request persistence for an origin that
 * already has it, and the late status can then overwrite the request's own result. `unpersisted`
 * is the settled, actionable pre-request state.
 */
export type PersistenceState =
  | "checking"
  | "already-persistent"
  | "unpersisted"
  | "granted"
  | "denied"
  | "unsupported"
  | "error";

/**
 * `navigator.storage`, if this browser has the two methods. **`null` is the unsupported case.**
 *
 * `null` rather than `undefined`, and the distinction is load-bearing rather than stylistic: a
 * default parameter is applied when a caller passes `undefined` **explicitly**, so a test writing
 * `mountPersistenceControl(root, undefined)` does not inject anything — it silently falls through
 * to the ambient `navigator` and passes or fails on whatever the test environment happens to
 * support. `null` is a value the default cannot swallow, so the unsupported branch is driven by
 * the caller and stays deterministic wherever it runs.
 */
export function readPersistenceApi(from: Navigator = navigator): PersistenceApi | null {
  // Checked by feature rather than by user agent, and both methods rather than the namespace:
  // `navigator.storage` exists in contexts where `persist` does not.
  const storage: Partial<StorageManager> | undefined = from.storage;
  if (storage === undefined) return null;
  if (typeof storage.persisted !== "function" || typeof storage.persist !== "function") {
    return null;
  }
  return {
    persisted: () => (from.storage as StorageManager).persisted(),
    persist: () => (from.storage as StorageManager).persist(),
  };
}

/** What each state tells the reader. Separate from the DOM so a test can assert wording. */
const HEADLINE: Readonly<Record<PersistenceState, string>> = Object.freeze({
  checking: "Checking whether storage is persistent.",
  "already-persistent": "Storage is already persistent.",
  unpersisted: "Saved data may be removed automatically.",
  granted: "Storage is now persistent.",
  denied: "The browser did not grant persistent storage.",
  unsupported: "This browser does not offer persistent storage.",
  // Neutral, because this state is reached from **two** places: a `persisted()` check that
  // rejected before anything was requested, and a `persist()` request that rejected. Copy naming
  // "the request" would describe a request that never happened on the first path.
  error: "The browser did not answer about persistent storage.",
});

/**
 * The detail under each headline.
 *
 * Three claims are load-bearing and are worded once, here, so a review can check them in one
 * place. **Scope:** persistence covers the whole origin *in this storage context* — trips,
 * events, media and map assets together — which is what the API does and what ADR-0016's
 * store split does *not* change. **What a grant buys:** exclusion from automatic eviction.
 * **What it does not:** the user can still clear the data, and a later write can still fail
 * when the quota is reached.
 */
const DETAIL: Readonly<Record<PersistenceState, string>> = Object.freeze({
  checking: "Asking the browser what it has already decided about this site.",
  "already-persistent":
    "Everything this site stores in this browser — recorded trips, events, photos and " +
    "downloaded map regions together — is already excluded from automatic eviction. You can " +
    "still clear it yourself, and writes can still fail once the quota is reached.",
  unpersisted:
    "The browser may evict everything this site stores in this browser — recorded trips, " +
    "events, photos and downloaded map regions together — to reclaim space. Requesting " +
    "persistent storage asks it not to.",
  granted:
    "Everything this site stores in this browser — recorded trips, events, photos and " +
    "downloaded map regions together — is now excluded from automatic eviction. You can still " +
    "clear it yourself, and writes can still fail once the quota is reached.",
  // Browser-neutral by ruling, and it is also the more accurate sentence: naming the browsers
  // that decide silently while omitting the one that asks is right about the ones it names and
  // misleading by omission about the other.
  denied:
    "This is a normal answer, not an error: some browsers decide automatically; others may ask. " +
    "Saved data can still be removed automatically, and the request can be made again later.",
  unsupported: "Saved data can still be removed automatically to reclaim space.",
  error:
    "The call failed rather than being refused, so persistence is unchanged and unknown. " +
    "Trying again is reasonable.",
});

/** Whether a state still leaves something to ask for. */
const canRequest = (state: PersistenceState): boolean =>
  state === "unpersisted" || state === "denied" || state === "error";

export interface PersistenceControl {
  readonly element: HTMLElement;
  /** For tests and for a caller that wants to report what happened. */
  readonly state: () => PersistenceState;
}

/**
 * Mount the control, reporting the current status before offering to change it.
 *
 * `persisted()` runs first and on its own: a control that offered to request persistence an
 * origin already has would be asking the user to fix a non-problem, and the answer is free.
 */
export function mountPersistenceControl(
  container: HTMLElement,
  api: PersistenceApi | null = readPersistenceApi(),
): PersistenceControl {
  const section = document.createElement("section");
  section.id = "persistence";

  // **A live region, and the button is deliberately outside it.** Every meaningful change here
  // is asynchronous — the status check answers, then a request answers — so a reader who is not
  // watching this corner of the page is told nothing without it. `role="status"` is the polite
  // one: it waits for a pause rather than interrupting, which is right for a result nobody is
  // blocked on. The button stays out because a live region announces its whole contents on
  // change, and re-reading the control's name every time the text moves is noise, not news.
  const live = document.createElement("div");
  live.className = "persistence-status";
  live.setAttribute("role", "status");

  const headline = document.createElement("p");
  headline.className = "persistence-headline";
  const detail = document.createElement("p");
  detail.className = "persistence-detail";
  live.append(headline, detail);

  // A real `<button>`, not a styled `<div>`: focusable and keyboard-operable by default, with
  // activation semantics the platform provides. The engine's accessibility guardrail asks for
  // the first two, and re-implementing the third with key handlers is how they get missed.
  const button = document.createElement("button");
  button.type = "button";
  button.id = "persistence-request";
  button.textContent = "Request persistent storage";

  section.append(live, button);
  container.append(section);

  let state: PersistenceState = "checking";

  const render = (next: PersistenceState): void => {
    state = next;
    section.dataset["state"] = next;
    headline.textContent = HEADLINE[next];
    detail.textContent = DETAIL[next];
    // **Hidden *and* disabled from the same expression.** `hidden` is the affordance; `disabled`
    // is what actually stops activation, because a hidden button still runs its click handler
    // when something calls `click()` on it. In `checking` that distinction is the whole point:
    // the status has not answered yet, and an activation reaching `persist()` from here would
    // request persistence for an origin that may already have it.
    //
    // Recomputed on every render rather than cleared, so a state reached *after* a request
    // re-arms the button instead of leaving it dead — the in-flight `disabled` below is a
    // separate rule, and this is the one that says whether there is anything left to ask for.
    button.hidden = !canRequest(next);
    button.disabled = !canRequest(next);
  };

  // **`checking`, not `unpersisted`.** Rendering the actionable state synchronously would put a
  // live button on the page while `persisted()` was still in flight — and a fast activation
  // could then request persistence for an origin that already had it, with the late status
  // answer overwriting the request's own result. `canRequest("checking")` is false, so the
  // button is hidden until the check has actually answered.
  render("checking");

  const request = (): void => {
    if (api === null) return;
    // **The in-flight guard, and its only home.** Firefox shows a permission prompt, so a
    // control that fired twice on one gesture would prompt twice. `disabled` is what stops the
    // second activation — the platform will not activate a disabled button — which is also why
    // there is no separate boolean beside it: two guards for one rule is one rule with two
    // homes, free to disagree.
    button.disabled = true;
    api.persist().then(
      (granted) => {
        render(granted ? "granted" : "denied");
      },
      () => {
        render("error");
      },
    );
  };

  button.addEventListener("click", request);

  if (api === null) {
    render("unsupported");
  } else {
    // Status first, and the request is only reachable through the button — nothing here calls
    // `persist()` on load. A request made during bootstrap prompts a Firefox user who never
    // asked for anything, which is the documented reason to wait for a gesture.
    api.persisted().then(
      (persisted) => {
        render(persisted ? "already-persistent" : "unpersisted");
      },
      () => {
        render("error");
      },
    );
  }

  return { element: section, state: () => state };
}
