import { defineConfig, mergeConfig } from "vitest/config";
import shared from "@weaver/config/vitest.shared";
export default mergeConfig(shared, defineConfig({ test: { testTimeout: 30_000, hookTimeout: 120_000 } }));
