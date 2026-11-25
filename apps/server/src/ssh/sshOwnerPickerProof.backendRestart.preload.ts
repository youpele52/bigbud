import { ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

// Bun test preload only. Observe the real DEV children without replacing the fixture, backend,
// native owner, or transport. Never record argv, wire bytes, or environment contents.
const trace = process.env.BIGBUD_TEST_SSH_OWNER_BACKEND_TRACE;
if (!trace) throw new Error("Missing disposable backend trace path");

const prototype = ChildProcess.prototype as ChildProcess & {
  spawn(options: { readonly file: string }): unknown;
};
const spawn = prototype.spawn;
if (typeof spawn !== "function") throw new Error("Bun child spawn observation unavailable");

prototype.spawn = function (options) {
  const tool = path.basename(options.file);
  if (["ssh", "ssh-keygen", "ssh-keyscan", "ssh-add", "ssh-agent"].includes(tool)) {
    // The DEV fixture uses synchronous absolute keygen, then the sandboxed Rust executable
    // launches native SSH itself. An async backend SSH child would be a different route.
    appendFileSync(`${trace}.fallback`, `${tool}\n`);
    throw new Error("Refusing SSH outside the selected disposable native owner");
  }
  const result = spawn.call(this, options);
  if (tool === "sshd" || tool === "start-picker-owner") {
    appendFileSync(`${trace}.children`, `${tool} ${this.pid}\n`);
    this.once("exit", () => appendFileSync(`${trace}.children`, `${tool} exited\n`));
    if (tool === "sshd") {
      this.stderr?.on("data", (data: Buffer) => appendFileSync(`${trace}.sshd`, data));
    }
  }
  return result;
};
