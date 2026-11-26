import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import type {
  DeploymentStepOperands,
  DeploymentStepState,
} from "../ssh/sshOwnerPickerProof.codec.backend.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import type { DeploymentFixture } from "./deployment.test.helpers.ts";

/**
 * A production-owner stand-in for the W2 T-backend integration tests. It runs the owner's
 * own bundled step script against the deployment fixture's private local "remote" account.
 * Only two lines are rewritten for the fixture: `PATH` gains the fixture shims (getent,
 * sha256sum on macOS) and `/etc/ssh` points at the fixture host keys. Streamed input
 * arrives on a real per-lease Unix socket, exactly as with the owner.
 */
const SCRIPT = readFileSync(
  new URL(
    "../../../../crates/bigbud-ssh-owner/src/bin/ssh_owner/owner_backend/deployment_step.sh",
    import.meta.url,
  ),
  "utf8",
);

const STREAMED = new Set(["manifestPut", "setupInputPut", "archiveUpload"]);

/** The operands as the owner's recipe orders them after `<op> <home|->`. */
function argv(step: DeploymentStepOperands): string[] {
  const home = step.home ?? "-";
  const req = step.requestId ?? "";
  const size = String(step.maxBytes ?? 0);
  switch (step.kind) {
    case "probeHost":
      return ["probe", "-", req];
    case "stageBegin":
      return ["begin", home, req, step.installName!, step.archiveSha256!, step.manifestSha256!];
    case "manifestPut":
      return ["put-manifest", home, req, step.inputSha256!, size];
    case "setupInputPut": {
      const name = step.setupInput === "rustManifest" ? "rust-manifest.json" : "trusted-keys.json";
      return ["put-input", home, req, name, step.inputSha256!, size];
    }
    case "archiveFetch":
      return ["fetch-url", home, req, step.archiveSha256!, step.url!, size];
    case "archiveUpload":
      return ["fetch-stdin", home, req, step.inputSha256!, size];
    case "publish":
      return [
        "commit",
        home,
        req,
        step.installName!,
        step.archiveSha256!,
        step.manifestSha256!,
        ...(step.pins ?? []).flatMap((pin) => [pin.path, pin.sha256]),
      ];
    case "setup":
      return ["setup", home, req, step.installName!, step.nodePath!, step.entryPath!];
    case "start":
      return [
        "start",
        home,
        step.installName!,
        step.nodePath!,
        step.entryPath!,
        step.authorityId!,
        step.enableBoot ? "1" : "0",
      ];
    case "readCompletion":
      return ["read-completion", "-", step.authorityId!];
    case "reset":
      return ["reset", home, req];
  }
}

const base = (lease: Uint8Array, step: DeploymentStepOperands) => ({
  lease,
  kind: step.kind,
  requestId: step.requestId ?? "",
});

interface Lease {
  state: DeploymentStepState;
  child?: ChildProcess;
  server?: Server;
}

export interface FakeProductionOwner {
  readonly registration: SshOwnerProductionRegistration;
  readonly steps: DeploymentStepOperands[];
  readonly opens: Uint8Array[];
  readonly cancels: Uint8Array[];
  /** Settle every later step of this kind as outcome-unknown without running it. */
  unknownFor?: DeploymentStepOperands["kind"];
  /** Hold every later step of this kind as running until cancelled. */
  holdFor?: DeploymentStepOperands["kind"];
  trust: "verified" | "approvalRequired";
}

export async function makeFakeProductionOwner(
  fixture: DeploymentFixture,
): Promise<FakeProductionOwner> {
  const bin = join(fixture.root, "bin");
  const hostKeys = join(fixture.root, "hostkeys");
  const script = SCRIPT.replace(/^PATH=\/usr\/bin:\/bin$/m, `PATH=${bin}:/usr/bin:/bin`).replaceAll(
    "/etc/ssh/",
    `${hostKeys}/`,
  );
  const sockets = await fs.mkdtemp(join(fixture.root, "s-"));
  const leases = new Map<string, Lease>();
  const owner: FakeProductionOwner = {
    steps: [],
    opens: [],
    cancels: [],
    trust: "verified",
    registration: undefined as unknown as SshOwnerProductionRegistration,
  };
  const run = (entry: Lease, step: DeploymentStepOperands, input?: NodeJS.ReadableStream) => {
    const child = spawn("/bin/sh", ["-c", script, "bigbud-deploy", ...argv(step)], {
      env: { LC_ALL: "C" },
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    entry.child = child;
    entry.state = { ...base(entry.state.lease, step), phase: "running" };
    if (input && child.stdin) input.pipe(child.stdin).on("error", () => {});
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("close", (code) => {
      if (entry.state.phase !== "running") return;
      entry.state =
        code === null
          ? { ...base(entry.state.lease, step), phase: "outcomeUnknown" }
          : { ...base(entry.state.lease, step), phase: "exited", exitCode: code, stdout, stderr };
    });
  };
  const bound = {
    inspectTrust: async () => ({
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:x",
      state: owner.trust,
    }),
    async openDeploymentStep(lease: Uint8Array, step: DeploymentStepOperands) {
      const key = Buffer.from(lease).toString("hex");
      const existing = leases.get(key);
      if (existing) return existing.state;
      owner.opens.push(lease);
      owner.steps.push(step);
      const entry: Lease = { state: { ...base(lease, step), phase: "running" } };
      leases.set(key, entry);
      if (owner.unknownFor === step.kind) {
        entry.state = { ...base(lease, step), phase: "outcomeUnknown" };
      } else if (owner.holdFor === step.kind) {
        // Held: never settles on its own.
      } else if (STREAMED.has(step.kind)) {
        const socketPath = join(sockets, randomBytes(4).toString("hex"));
        entry.server = createServer({ allowHalfOpen: true }, (socket) => {
          entry.server?.close();
          run(entry, step, socket);
        });
        await new Promise<void>((resolve) => entry.server!.listen(socketPath, resolve));
        entry.state = { ...base(lease, step), phase: "listening", socketPath };
      } else run(entry, step);
      return entry.state;
    },
    async deploymentStepStatus(lease: Uint8Array) {
      const entry = leases.get(Buffer.from(lease).toString("hex"));
      if (!entry) throw new Error("operationDenied");
      return entry.state;
    },
    async cancelDeploymentStep(lease: Uint8Array) {
      owner.cancels.push(lease);
      const entry = leases.get(Buffer.from(lease).toString("hex"));
      if (!entry) throw new Error("operationDenied");
      if (entry.state.phase === "running" || entry.state.phase === "listening") {
        entry.server?.close();
        entry.child?.kill("SIGKILL");
        entry.state = {
          lease,
          kind: entry.state.kind,
          requestId: entry.state.requestId,
          phase: "cancelled",
        };
      }
      return entry.state;
    },
  };
  (owner as { registration: SshOwnerProductionRegistration }).registration = {
    handle: { target: () => bound, state: () => "open" },
    descriptorFor: async () => ({ targetId: "fixture" }),
  } as unknown as SshOwnerProductionRegistration;
  return owner;
}
