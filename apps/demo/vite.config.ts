// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev/preview only — the repo gates build the demo with `tsc`. Run `npm run dev`
// inside apps/demo to serve the field logger.
export default defineConfig({
  plugins: [react()],
  root: ".",
});
