import { defineConfig, mergeConfig } from "vitest/config";
import shared from "@weaver/config/vitest.shared";
export default mergeConfig(shared, defineConfig({}));
