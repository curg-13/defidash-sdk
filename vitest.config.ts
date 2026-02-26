import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    // On-chain RPC calls need generous timeouts
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
