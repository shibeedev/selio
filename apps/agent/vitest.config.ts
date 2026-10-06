import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const shim = fileURLToPath(new URL("./src/testing/node-sqlite-shim.ts", import.meta.url));

export default defineConfig({
  plugins: [
    {
      // Vitest 2 (vite-node) rewrites "node:sqlite" to "sqlite", which does not exist; serve a shim instead.
      name: "node-sqlite-shim",
      enforce: "pre",
      resolveId: (id) => (id === "node:sqlite" || id === "sqlite" ? shim : null),
    },
  ],
  test: { environment: "node" },
});
