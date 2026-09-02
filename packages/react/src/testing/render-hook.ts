// SPDX-License-Identifier: Apache-2.0

import { StrictMode, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { act } from "react";

/**
 * A hook harness over `createRoot` and `act`, deliberately smaller than a testing library.
 *
 * Testing Library is not taken pre-emptively: these tests mount a hook, change its arguments,
 * unmount it, and read what it returned. No queries, no user-event simulation, no async
 * utilities — nothing the dependency would provide. If this file starts growing those, that is
 * the signal to switch rather than to keep extending it.
 *
 * `IS_REACT_ACT_ENVIRONMENT` is set explicitly rather than left to whatever React infers, so the
 * act semantics are a property of the harness instead of a warning nobody reads.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

export interface HookHarness<Props, Value> {
  /** What the hook returned on its most recent render. */
  readonly current: Value;
  /** Every value the hook has returned, oldest first — for asserting what a render sequence did. */
  readonly renders: readonly Value[];
  /** Re-render with different arguments. Prop replacement is a contract here, not a detail. */
  rerender(props: Props): Promise<void>;
  unmount(): Promise<void>;
  /** Flush effects and microtasks the hook scheduled — a settled point to assert against. */
  settle(): Promise<void>;
}

export interface RenderHookOptions {
  /**
   * Mount inside `StrictMode`, which double-invokes effects.
   *
   * Off by default and on where it is the subject: a hook that duplicated a durable action —
   * persisted twice, downloaded twice — would corrupt real data, and development builds are
   * where that first shows up.
   */
  strict?: boolean;
}

/** A mounted component under the same act/flush machinery as {@link renderHook}. */
export interface ComponentHarness<Props> {
  readonly container: HTMLElement;
  rerender(props: Props): Promise<void>;
  unmount(): Promise<void>;
  settle(): Promise<void>;
}

/**
 * Render a real component tree, not a probe.
 *
 * {@link renderHook}'s probe returns `null`, so anything the hook *returns to render* — a
 * container `<div>` whose ref an effect reads — never reaches the DOM. A component under test
 * has to actually mount.
 */
export async function renderComponent<Props>(
  component: (props: Props) => ReactNode,
  initialProps: Props,
  options: RenderHookOptions = {},
): Promise<ComponentHarness<Props>> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);

  const tree = (props: Props): ReactNode => {
    const element = createElement(component as never, props as never);
    return options.strict === true ? createElement(StrictMode, null, element) : element;
  };
  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  await act(async () => {
    root.render(tree(initialProps));
  });
  await flush();

  return {
    container,
    rerender: async (props) => {
      await act(async () => {
        root.render(tree(props));
      });
      await flush();
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
    settle: flush,
  };
}

export async function renderHook<Props, Value>(
  hook: (props: Props) => Value,
  initialProps: Props,
  options: RenderHookOptions = {},
): Promise<HookHarness<Props, Value>> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const renders: Value[] = [];

  function Probe({ props }: { props: Props }): null {
    renders.push(hook(props));
    return null;
  }

  const tree = (props: Props): ReactNode => {
    const probe = createElement(Probe, { props });
    return options.strict === true ? createElement(StrictMode, null, probe) : probe;
  };

  const flush = async (): Promise<void> => {
    // Two turns: one for effects React scheduled, one for promises those effects awaited. A
    // single turn leaves an async initial load half-done and the assertion racing it.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  await act(async () => {
    root.render(tree(initialProps));
  });
  await flush();

  return {
    get current(): Value {
      const latest = renders.at(-1);
      if (latest === undefined) throw new Error("the hook has not rendered");
      return latest;
    },
    renders,
    rerender: async (props) => {
      await act(async () => {
        root.render(tree(props));
      });
      await flush();
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
    settle: flush,
  };
}
