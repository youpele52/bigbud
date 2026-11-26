// Standalone source-only development entry. Never import this from the normal backend or a release entry.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { access, constants, realpath } from "node:fs/promises";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { renderDevSshOwnerPickerPage } from "./sshOwnerDevPicker.page.ts";
import { installDevSshOwnerSandbox } from "./sshOwnerDevPicker.sandbox.ts";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

const NO_CACHE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const HOST = "127.0.0.1";

function json(status: number, value: object) {
  return Response.json(value, { status, headers: NO_CACHE });
}

function challengeFromMessage(message: string) {
  if (!message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX)) return undefined;
  try {
    return Schema.decodeUnknownSync(SshHostTrustChallenge)(
      JSON.parse(message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
    );
  } catch {
    return undefined;
  }
}

function validateBody(body: unknown, executionTargetId: string) {
  if (
    typeof body !== "object" ||
    body === null ||
    !("executionTargetId" in body) ||
    body.executionTargetId !== executionTargetId
  ) {
    throw new Error("This picker only accepts its bound development target.");
  }
  return {
    folder:
      typeof ("path" in body ? body.path : undefined) === "string" && "path" in body
        ? (body.path as string)
        : undefined,
    challengeId:
      typeof ("challengeId" in body ? body.challengeId : undefined) === "string" &&
      "challengeId" in body
        ? (body.challengeId as string)
        : undefined,
  };
}

async function main() {
  const artifact = process.env.BIGBUD_SSH_OWNER_BIN;
  if (
    process.env.BIGBUD_SSH_OWNER !== "1" ||
    !process.versions.bun ||
    process.platform !== "darwin" ||
    !artifact ||
    !path.isAbsolute(artifact)
  ) {
    throw new Error("The isolated picker requires the opted-in macOS development launcher.");
  }
  const binary = await realpath(artifact);
  await access(binary, constants.X_OK);
  const fixture = await makeLoopbackPickerFixture();
  try {
    await fixture.start();
    const launcher = await installDevSshOwnerSandbox({
      root: fixture.root,
      source: binary,
      existingClientPolicy: fixture.clientSandboxPolicy,
    });
    const runtime = ManagedRuntime.make(
      makeSqlitePersistenceLive(path.join(fixture.root, "dev-picker.sqlite"), {
        worker: false,
      }).pipe(Layer.provide(NodeServices.layer)),
    );
    try {
      const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
      const executionTargetId = fixture.executionTargetId;
      const newPicker = () =>
        makeSshOwnerDevPicker({
          executionTargetId,
          host: fixture.host,
          startOwner: (profileBinding) =>
            startPickerProofOwner({
              binary: launcher,
              profileBinding: Buffer.from(profileBinding),
              targetId: executionTargetId,
              lockFile: path.join(fixture.root, "owner.lock"),
              sshBinary: fixture.ssh,
              keyscanBinary: "/usr/bin/ssh-keyscan",
              host: fixture.loopback,
              port: fixture.port,
              user: fixture.user,
              identityFile: fixture.identity,
              knownHostsFile: fixture.knownHosts,
              sql,
            }),
        });
      let picker = newPicker();
      let working = false;
      const token = randomBytes(32).toString("base64url");
      const tokenBytes = Buffer.from(token);
      const input = { executionTargetId };
      const status = async () => ({
        disconnected:
          (
            await runtime.runPromise(sql`
        SELECT 1 FROM remote_execution_target_disconnects WHERE target_id = ${executionTargetId}
      `)
          ).length > 0,
      });
      const server = Bun.serve({
        hostname: HOST,
        port: 0,
        idleTimeout: 60,
        maxRequestBodySize: 16 * 1024,
        async fetch(req, server) {
          const origin = `http://${HOST}:${server.port}`;
          const url = new URL(req.url);
          if (req.headers.get("host") !== `${HOST}:${server.port}` || url.origin !== origin) {
            return json(403, { ok: false, message: "Invalid picker host." });
          }
          if (req.method === "GET" && url.pathname === "/") {
            return new Response(renderDevSshOwnerPickerPage("", executionTargetId, fixture.host), {
              headers: {
                ...NO_CACHE,
                "Content-Type": "text/html; charset=utf-8",
                "Referrer-Policy": "no-referrer",
                "Content-Security-Policy":
                  "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
              },
            });
          }
          if (req.method !== "POST") return json(404, { ok: false, message: "Not found." });
          const received = Buffer.from(req.headers.get("x-bigbud-picker-token") ?? "");
          if (
            req.headers.get("origin") !== origin ||
            received.length !== tokenBytes.length ||
            !timingSafeEqual(received, tokenBytes)
          ) {
            return json(401, { ok: false, message: "Missing or invalid picker session." });
          }
          if (working)
            return json(409, { ok: false, message: "The Rust picker is busy. Try again." });
          working = true;
          try {
            const { folder, challengeId } = validateBody(await req.json(), executionTargetId);
            let value: unknown;
            switch (url.pathname) {
              case "/api/list":
                value = await picker.listRemoteFolders({
                  ...input,
                  ...(folder === undefined ? {} : { path: folder }),
                });
                break;
              case "/api/trust":
                if (challengeId === undefined) throw new Error("No host-key challenge supplied.");
                value = await picker.trustSshHost({ ...input, challengeId });
                break;
              case "/api/connect":
                value = await picker.connectExecutionTarget(input);
                break;
              case "/api/disconnect":
                value = await picker.disconnectExecutionTarget(input);
                break;
              case "/api/status":
                value = await status();
                break;
              case "/api/restart-owner":
                await picker.close();
                picker = newPicker();
                value = await status();
                break;
              default:
                return json(404, { ok: false, message: "Not found." });
            }
            return json(200, { ok: true, value });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "The Rust picker request failed.";
            const challenge = challengeFromMessage(message);
            return json(400, {
              ok: false,
              message: challenge ? "Host key approval is required." : message,
              ...(challenge ? { challenge } : {}),
            });
          } finally {
            working = false;
          }
        },
      });
      try {
        console.log(`Rust SSH owner picker: ${binary} (disposable data, no legacy backend)`);
        console.log(`BIGBUD_SSH_OWNER_PICKER_URL=http://${HOST}:${server.port}/#${token}`);
        await new Promise<void>((resolve) => {
          const stop = () => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            resolve();
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
      } finally {
        await server.stop(true);
        await picker.close();
      }
    } finally {
      await runtime.dispose();
    }
  } finally {
    await fixture.dispose();
  }
}

await main();
