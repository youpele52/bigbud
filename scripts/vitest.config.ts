import { configDefaults, defineConfig } from "vitest/config";
import { checkpointNodeTestExcludes, scriptsRoot } from "./lib/checkpoint-node-tests.inventory";

export default defineConfig({
  root: scriptsRoot,
  test: {
    // These are not skipped: checkpoint-node.test.ts runs each through actual Node.
    exclude: [...configDefaults.exclude, ...checkpointNodeTestExcludes],
  },
});
