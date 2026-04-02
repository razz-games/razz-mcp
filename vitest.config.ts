import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: "./src",
    globals: true,
    environment: "node",
    include: ["**/__tests__/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
