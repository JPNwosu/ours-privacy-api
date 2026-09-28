import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The entry point only reads PORT and calls listen; everything it wires up is tested via createApp.
      exclude: ["src/index.ts"],
      reporter: ["text", "html"],
      thresholds: { lines: 90, branches: 80, functions: 90, statements: 85 },
    },
  },
});
