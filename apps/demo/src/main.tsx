// SPDX-License-Identifier: Apache-2.0
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Leaflet's stylesheet is linked from index.html (kept out of the TS graph so
// the app compiles with `tsc`; a production consumer should self-host it).
const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
