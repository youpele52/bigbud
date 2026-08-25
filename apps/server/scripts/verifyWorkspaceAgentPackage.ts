import { resolve } from "node:path";

import { assertCompleteServerWorkspaceAgentSet } from "./workspaceAgent.ts";

assertCompleteServerWorkspaceAgentSet(resolve(import.meta.dirname, ".."));
console.log("Verified the complete standalone server workspace watcher artifact set.");
