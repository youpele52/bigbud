import { createHash } from "node:crypto";
import { quoteRemoteAgentLaunchValue as quote } from "../remote-agent/remoteAgentRuntime.launch.prepare.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import {
  decodeLocalSupervisorServiceConfig,
  encodeLocalSupervisorServiceConfig,
} from "./localSupervisorService.config.ts";

/** Update only P4's launch projection; the account-service config is never another owner ledger. */
export function buildLocalSupervisorServiceProjection(input: {
  readonly runtime: RemoteAgentRuntime;
  readonly configPath: string;
  readonly previousConfig: string;
  readonly attemptId: string;
  readonly priorEpoch: string;
  readonly bootId: string;
}): { readonly script: string; readonly stdin: string } {
  if (
    !/^[A-Za-z0-9-]{1,64}$/.test(input.attemptId) ||
    !(input.priorEpoch === "fresh" || /^[0-9]+$/.test(input.priorEpoch)) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.bootId)
  )
    throw new Error("Invalid service launch projection.");
  const config = decodeLocalSupervisorServiceConfig(input.previousConfig);
  if (
    config.rust_binary !== input.runtime.binaryPath ||
    config.rust_sha256 !== input.runtime.sha256 ||
    config.rust_state !== input.runtime.statePath
  )
    throw new Error("Service config does not select the reserved managed runtime.");
  const stdin = encodeLocalSupervisorServiceConfig({
    ...config,
    launch_attempt: input.attemptId,
    prior_epoch: input.priorEpoch,
    launch_boot: input.bootId,
  });
  return {
    stdin,
    script: `set -eu
umask 077
state=${quote(input.runtime.statePath)}
config=${quote(input.configPath)}
private_file() {
  test ! -L "$1"; test -f "$1"
  test "$(stat -c '%u:%a:%h' -- "$1")" = "$(id -u):600:1"
}
private_file "$state/launch.lock"
exec 8<> "$state/launch.lock"
flock -n -x 8
private_file "$state/launch.intent"; private_file "$state/launch.boot"
test "$(cat "$state/launch.intent")" = ${quote(input.attemptId)}
test "$(cat "$state/launch.boot")" = ${quote(input.bootId)}
test "$(cat /proc/sys/kernel/random/boot_id)" = ${quote(input.bootId)}
private_file "$config"
test "$(sha256sum -- "$config" | cut -d ' ' -f1)" = '${createHash("sha256").update(input.previousConfig).digest("hex")}'
temporary=$(mktemp "$config.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
cat > "$temporary"
test "$(sha256sum -- "$temporary" | cut -d ' ' -f1)" = '${createHash("sha256").update(stdin).digest("hex")}'
sync -f "$temporary"
mv -T -- "$temporary" "$config"
sync -f "$(dirname -- "$config")"
`,
  };
}
