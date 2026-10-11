import { installExperimentalCheckpoint } from "./checkpoint.extension.mjs";

const target = globalThis.__bigbudCheckpointExperimentTarget;
target.Terminal = installExperimentalCheckpoint(
  target.Terminal,
  globalThis.__bigbudCheckpointExperimentBuild,
);
