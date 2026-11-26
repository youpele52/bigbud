import { createHash } from "node:crypto";
import type { DeploymentStepOperands } from "../ssh/sshOwnerPickerProof.codec.backend.ts";
import { GRAPH_STAGE_SCRIPT } from "./deployment.fetch.ts";
import { REMOTE_PROBE_SCRIPT, SSH_HOST_KEY_DIR } from "./deployment.remoteSetup.ts";
import {
  deploymentError,
  DEPLOYMENT_REQUEST_ID,
  REMOTE_ABSOLUTE_PATH,
  type DeploymentRemoteCommand,
} from "./deployment.types.ts";

/**
 * W2 T-backend: translate each exact legacy deployment command into one typed production
 * owner step. Only the commands the deployment core actually issues are recognized, with
 * their exact scripts, argument shapes, environment and deadlines; anything else is a typed
 * refusal, never a launch. The owner re-validates every operand and compiles the remote
 * recipe itself, so these strings never reach a shell.
 *
 * @module deployment.ssh.owner.production.match
 */

export type ProductionStepInput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "file"; readonly path: string };

export interface ProductionStep {
  readonly operands: DeploymentStepOperands;
  /** Bytes for the lease socket; the owner checks their size and digest remotely. */
  readonly input?: ProductionStepInput;
  /** The legacy deadline; the owner enforces the same one. */
  readonly timeoutMs: number;
}

const DIGEST = /^[a-f0-9]{64}$/;
const AUTHORITY = /^[a-f0-9]{32}$/;
const GRAPH_PATH = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;
const INSTALL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const ARCHIVE_MAX_BYTES = 2 * 1024 ** 3;
const MINUTE = 60_000;

const unsupported = () =>
  deploymentError("unavailable", "This deployment step is not supported by the SSH owner.");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function need(ok: boolean): asserts ok {
  if (!ok) throw unsupported();
}
/** The value, once it matches `pattern`; otherwise a typed refusal. */
const exact = (pattern: RegExp, value: string | undefined): string => {
  need(value !== undefined && pattern.test(value));
  return value;
};
const graphPath = (value: string | undefined): string => {
  need(value !== undefined && GRAPH_PATH.test(value) && !value.split("/").includes(".."));
  return value;
};

/** `<home>/.bigbud/backend-graphs/<install>/graph/<member>` split into its parts. */
function graphMember(path: string) {
  const match = /^(\/.+)\/\.bigbud\/backend-graphs\/([^/]+)\/graph\/(.+)$/.exec(path);
  need(match !== null);
  const [, home, install, member] = match;
  need(home !== undefined && REMOTE_ABSOLUTE_PATH.test(home) && !home.split("/").includes(".."));
  need(install !== undefined && INSTALL.test(install));
  return { home, install, member: graphPath(member) };
}

function stageStep(command: DeploymentRemoteCommand): ProductionStep {
  const [op, requestId, ...rest] = command.args.slice(3);
  need(requestId !== undefined && DEPLOYMENT_REQUEST_ID.test(requestId));
  const stdin = command.stdin;
  const text = stdin && "text" in stdin ? stdin.text : undefined;
  const timed = (timeoutMs: number, step: Omit<ProductionStep, "timeoutMs">) => {
    need(command.timeoutMs === timeoutMs);
    return { ...step, timeoutMs };
  };
  switch (op) {
    case "begin": {
      need(rest.length === 3 && stdin === undefined);
      const installName = exact(INSTALL, rest[0]);
      const archiveSha256 = exact(DIGEST, rest[1]);
      const manifestSha256 = exact(DIGEST, rest[2]);
      return timed(MINUTE, {
        operands: { kind: "stageBegin", requestId, installName, archiveSha256, manifestSha256 },
      });
    }
    case "put":
    case "put-input": {
      const [name, inputSha256] = rest;
      need(rest.length === 2 && text !== undefined && DIGEST.test(inputSha256 ?? ""));
      // The legacy recipe hashes the bytes remotely; refuse a mismatch before dispatch.
      need(sha256(text) === inputSha256);
      const maxBytes = Buffer.byteLength(text);
      const input = { kind: "text", text } as const;
      if (op === "put") {
        need(name === "manifest.json");
        return timed(MINUTE, {
          operands: { kind: "manifestPut", requestId, inputSha256, maxBytes },
          input,
        });
      }
      need(name === "rust-manifest.json" || name === "trusted-keys.json");
      const setupInput = name === "rust-manifest.json" ? "rustManifest" : "trustedKeys";
      return timed(MINUTE, {
        operands: { kind: "setupInputPut", requestId, setupInput, inputSha256, maxBytes },
        input,
      });
    }
    case "fetch-url": {
      const [, url, max] = rest;
      need(rest.length === 3 && stdin === undefined);
      const archiveSha256 = exact(DIGEST, rest[0]);
      need(url !== undefined && url.startsWith("https://") && max === String(ARCHIVE_MAX_BYTES));
      return timed(30 * MINUTE, {
        operands: {
          kind: "archiveFetch",
          requestId,
          archiveSha256,
          url,
          maxBytes: ARCHIVE_MAX_BYTES,
        },
      });
    }
    case "fetch-stdin": {
      need(rest.length === 1 && stdin !== undefined && "path" in stdin);
      const inputSha256 = exact(DIGEST, rest[0]);
      // The byte count is read from the local file just before the stream opens.
      return timed(30 * MINUTE, {
        operands: { kind: "archiveUpload", requestId, inputSha256 },
        input: { kind: "file", path: stdin.path },
      });
    }
    case "commit": {
      need(rest.length === 9 && stdin === undefined);
      const installName = exact(INSTALL, rest[0]);
      const archiveSha256 = exact(DIGEST, rest[1]);
      const manifestSha256 = exact(DIGEST, rest[2]);
      const pins = [3, 5, 7].map((index) => ({
        path: graphPath(rest[index]),
        sha256: exact(DIGEST, rest[index + 1]),
      }));
      return timed(10 * MINUTE, {
        operands: { kind: "publish", requestId, installName, archiveSha256, manifestSha256, pins },
      });
    }
    default:
      throw unsupported();
  }
}

function backendStep(command: DeploymentRemoteCommand): ProductionStep {
  const node = graphMember(command.command);
  const [entryPath, backend, verb, ...rest] = command.args;
  need(entryPath !== undefined && backend === "backend");
  const entry = graphMember(entryPath);
  need(entry.home === node.home && entry.install === node.install);
  const { home, install: installName } = node;
  need(
    command.stdin === undefined &&
      Object.keys(command.env ?? {}).length === 2 &&
      command.env?.HOME === home &&
      command.env.LANG === "C.UTF-8",
  );
  const paths = { home, installName, nodePath: node.member, entryPath: entry.member };
  if (verb === "setup") {
    const requestId = rest.at(-2) ?? "";
    need(DEPLOYMENT_REQUEST_ID.test(requestId) && command.timeoutMs === 20 * MINUTE);
    const install = `${home}/.bigbud/backend-graphs/${installName}`;
    const inputs = `${home}/.bigbud/backend-setup/${requestId}`;
    const expected = [
      "--graph-root",
      `${install}/graph`,
      "--graph-manifest",
      `${install}/manifest.json`,
      "--rust-manifest",
      `${inputs}/rust-manifest.json`,
      "--trusted-keys",
      `${inputs}/trusted-keys.json`,
      "--backend-home",
      `${home}/.bigbud/backend`,
      "--request-id",
      requestId,
      "--confirm-fresh-setup",
    ];
    need(rest.length === expected.length && rest.every((arg, index) => arg === expected[index]));
    return { operands: { kind: "setup", requestId, ...paths }, timeoutMs: 20 * MINUTE };
  }
  const [flag, , consent] = rest;
  need(flag === "--authority");
  const authorityId = exact(AUTHORITY, rest[1]);
  need(command.timeoutMs === 5 * MINUTE);
  const enableBoot = verb === "enable";
  need(
    enableBoot
      ? rest.length === 3 && consent === "--confirm-startup"
      : verb === "start" && rest.length === 2,
  );
  return { operands: { kind: "start", authorityId, enableBoot, ...paths }, timeoutMs: 5 * MINUTE };
}

/** One legacy command to one typed owner step, or a typed refusal. */
export function matchProductionDeploymentStep(command: DeploymentRemoteCommand): ProductionStep {
  const [flag, script, argv0] = command.args;
  if (command.command === "/bin/sh" && flag === "-c" && argv0 === "sh") {
    need(command.env === undefined);
    if (script === GRAPH_STAGE_SCRIPT) return stageStep(command);
    need(
      script === REMOTE_PROBE_SCRIPT &&
        command.args.length === 5 &&
        command.args[4] === SSH_HOST_KEY_DIR &&
        command.stdin === undefined &&
        command.timeoutMs === 30_000,
    );
    const requestId = exact(DEPLOYMENT_REQUEST_ID, command.args[3]);
    return { operands: { kind: "probeHost", requestId }, timeoutMs: 30_000 };
  }
  return backendStep(command);
}
