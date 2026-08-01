import { defineConfig } from "tsup";

export default defineConfig({
  entry:    { engine: "src/engine.ts" },
  format:   "esm",
  target:   "node18",
  platform: "node",
  splitting: false,
  bundle:   true,
  // Output engine.js at the repo root — this is the file you upload to the marketplace.
  outDir:   ".",
  clean:    false,          // don't delete other root files
  external: ["events", "crypto"],  // Node.js built-ins; don't bundle
});
