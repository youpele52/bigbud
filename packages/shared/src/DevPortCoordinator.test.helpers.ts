import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach } from "vitest";

import { createDevPortCoordinator, type DevPortReservation } from "./DevPortCoordinator";

interface Message {
  event: string;
  reservation?: DevPortReservation;
}

const roots: string[] = [];
const workers: { kill: () => Promise<void> }[] = [];

export async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "bigbud-port-coordinator-test-"));
  roots.push(root);
  return {
    root,
    coordinator: await createDevPortCoordinator(root, path.join(root, "storage")),
  };
}

export function worker(root: string, mode: string, parentToken?: string) {
  const child = fork(
    fileURLToPath(new URL("./DevPortCoordinator.test.worker.ts", import.meta.url)),
    [root, mode, ...(parentToken ? [parentToken] : [])],
    { execPath: "node", execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const messages: Message[] = [];
  const listeners = new Set<() => void>();
  let exited = false;
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      exited = true;
      resolve(code);
      for (const listener of listeners) listener();
    });
  });
  child.on("message", (message: Message) => {
    messages.push(message);
    for (const listener of listeners) listener();
  });
  const result = {
    child,
    done,
    message(event: string): Promise<Message> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Worker did not send ${event}: ${stderr}`));
        }, 10_000);
        function check() {
          const message = messages.find((item) => item.event === event);
          if (!message && !exited) return;
          clearTimeout(timer);
          listeners.delete(check);
          if (message) resolve(message);
          else reject(new Error(`Worker exited before ${event}: ${stderr}`));
        }
        listeners.add(check);
        check();
      });
    },
    async kill() {
      if (!exited) child.kill("SIGKILL");
      await done;
    },
    get stderr() {
      return stderr;
    },
  };
  workers.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((item) => item.kill()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
