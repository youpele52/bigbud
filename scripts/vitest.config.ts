import { configDefaults, defineConfig } from "vitest/config";
import { checkpointNodeTestExcludes, scriptsRoot } from "./lib/checkpoint-node-tests.inventory";

export default defineConfig({
  root: scriptsRoot,
  test: {
    // Packaging tests stage graphs and archives; 1 s locally can exceed 5 s on a busy CI runner.
    testTimeout: 30_000,
    // These are not skipped: checkpoint-node.test.ts runs each through actual Node.
    exclude: [...configDefaults.exclude, ...checkpointNodeTestExcludes],
  },
});
