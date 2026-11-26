import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";

import { SshOwnerRequiredError } from "./sshOwnerRequired.ts";

/**
 * Remote system statistics for an SSH target. Stats need the owner's typed
 * `subscribeStatus` verb (C03), which is not on the wire yet, so a sample is
 * refused typed and no SSH process is started. Reachability is the owner's
 * `sample_health` (`sshMonitor.connections.ts`), not a stats sample.
 */
export async function sampleSshMonitor(_target: string): Promise<MonitorSnapshot> {
  throw new SshOwnerRequiredError();
}
