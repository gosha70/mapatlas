// SPDX-License-Identifier: Apache-2.0

/**
 * Demo entry point. Mounts the field-logger app into `#root`. Guarded so the
 * module is import-safe in non-DOM environments (SSR / tests).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

export function mount(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

if (typeof document !== "undefined") {
  const el = document.getElementById("root");
  if (el) mount(el);
}
