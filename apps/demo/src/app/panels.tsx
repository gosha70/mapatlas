// SPDX-License-Identifier: Apache-2.0

/**
 * T6.2's persistence control and installation guidance, as panels of the app.
 *
 * The ruling that put them here was about **placement**: they are the app's own settings, and a
 * separate vanilla page for them stopped making sense once the app existed. So these are thin
 * React wrappers around the mount functions T6.2 already ships and already tests — 28 assertions
 * and 20 mutations' worth — rather than rewrites of them.
 *
 * **Why wrap rather than rewrite.** The control is a demonstration of a *browser* API, not of
 * MAP-ATLAS's, so how idiomatic its internals are teaches a consumer nothing about this engine;
 * and rewriting it would discard the tests that pin its five outcomes, its call counts and its
 * copy. Mounting an imperative widget from an effect is an ordinary React pattern, and it is
 * honest about what this code is. If it should be idiomatic React for its own sake, that is a
 * change with its own reason and its own review.
 *
 * **Cleanup is not optional here.** `mountPersistenceControl` and `mountInstallGuidance`
 * *append*, and React 19's StrictMode mounts, unmounts and remounts every effect in development
 * — so without removing the element on cleanup the page would carry two of each. That is the
 * exact failure T5.3 hit and the browser lane caught, so it is written in from the start.
 */

import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

import { mountInstallGuidance } from "../install-guidance.js";
import { mountPersistenceControl } from "../persistence.js";

/** One panel per mount function; the difference between them is only which one runs. */
function MountedPanel({
  mount,
  className,
}: {
  mount: (container: HTMLElement) => HTMLElement | { element: HTMLElement };
  className: string;
}): ReactElement {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = host.current;
    if (container === null) return undefined;
    const mounted = mount(container);
    const element = "element" in mounted ? mounted.element : mounted;
    return () => {
      element.remove();
    };
  }, [mount]);

  return <div className={className} ref={host} />;
}

export function PersistencePanel(): ReactElement {
  return <MountedPanel mount={mountPersistenceControl} className="panel-persistence" />;
}

export function InstallPanel(): ReactElement {
  return <MountedPanel mount={mountInstallGuidance} className="panel-install" />;
}
