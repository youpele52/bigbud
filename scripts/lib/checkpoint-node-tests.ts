import path from "node:path";
import { scriptsRoot } from "./checkpoint-node-tests.inventory";
import { executeOwnedNode, OwnedNodeHarnessError } from "./checkpoint-node-tests.process";
export { checkpointNodeCleanupMs } from "./checkpoint-node-tests.process";

export const checkpointNodeTimeoutMs = 120_000;
const outputBytes = 2 * 1024 * 1024;

interface NodeTestFailure {
  code?: string | number;
  signal?: string;
  message?: string;
  stdout?: string;
  stderr?: string;
}
function summaryCount(stdout: string, name: string): number {
  const value = stdout.match(new RegExp(`^# ${name} (\\d+)\\r?$`, "m"))?.[1];
  if (value === undefined) throw new Error(`Node TAP summary is missing ${name}`);
  return Number(value);
}

/** Run one harness in a fresh actual Node process; no Vitest/Bun interpretation of node:test. */
export async function runCheckpointNodeTest(
  file: string,
  options: {
    timeoutMs?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? checkpointNodeTimeoutMs;
  const maxBuffer = options.maxBuffer ?? outputBytes;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > checkpointNodeTimeoutMs ||
    !Number.isSafeInteger(maxBuffer) ||
    maxBuffer <= 0 ||
    maxBuffer > outputBytes
  ) {
    throw new Error("Invalid checkpoint Node test resource bounds");
  }
  try {
    const { stdout } = await executeOwnedNode(
      ["--test", "--test-isolation=none", "--test-reporter=tap", path.resolve(file)],
      {
        cwd: path.resolve(scriptsRoot, ".."),
        timeoutMs,
        maxBuffer,
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const counts = {
      tests: summaryCount(stdout, "tests"),
      pass: summaryCount(stdout, "pass"),
      fail: summaryCount(stdout, "fail"),
      cancelled: summaryCount(stdout, "cancelled"),
      skipped: summaryCount(stdout, "skipped"),
      todo: summaryCount(stdout, "todo"),
    };
    // Node reports an empty file itself as one passing test. That is not a node:test suite.
    const namedTests = [...stdout.matchAll(/^# Subtest: (.+)\r?$/gm)].some(
      (match) => match[1]?.trim() !== path.resolve(file),
    );
    if (
      !namedTests ||
      counts.tests === 0 ||
      counts.pass === 0 ||
      counts.fail !== 0 ||
      counts.cancelled !== 0 ||
      counts.skipped !== 0 ||
      counts.todo !== 0
    ) {
      throw new Error(`Node harness did not complete every test: ${JSON.stringify(counts)}`);
    }
    return counts;
  } catch (error) {
    const failure = error as NodeTestFailure;
    const message = `Node checkpoint harness ${path.basename(file)} failed (${failure.code ?? failure.signal ?? "runner"}): ${failure.message ?? "unknown failure"}\n${(failure.stdout ?? "").slice(-8192)}\n${(failure.stderr ?? "").slice(-8192)}`;
    if (error instanceof OwnedNodeHarnessError)
      throw new OwnedNodeHarnessError(error.code, message);
    throw new Error(message, { cause: error });
  }
}
