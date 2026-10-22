import { defineConfig, mergeConfig } from "vitest/config";
import shared from "@weaver/config/vitest.shared";
// Generous timeouts: database/object-store containers start slowly when many suites run in parallel.
export default mergeConfig(shared, defineConfig({ test: { testTimeout: 30_000, hookTimeout: 120_000 } }));
