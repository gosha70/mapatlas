// Temporary — added only to VIEW pi's demo UI (pi shipped no bundler).
import { defineConfig } from "vite";
export default defineConfig({
  server: { port: 5174 },
  resolve: { extensions: [".ts", ".tsx", ".js", ".jsx", ".json", ".mjs"] },
});
