import { spawn } from "node:child_process";

const CLIENT_HELLO_FRAME = Buffer.from(
  "000000290a27080110011a08636c69656e742d31220c636f6e6e656374696f6e2d312a056e6f6e636530808040",
  "hex",
);

export async function verifyWorkspaceAgentHandshake(binaryPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, ["--ephemeral"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => finish(new Error(`handshake timed out: ${stderr.trim()}`)),
      5_000,
    );
    child.once("error", finish);
    child.stdin.on("error", () => {
      // The child may close stdin while the verifier is terminating it.
    });
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`agent exited (code=${code}, signal=${signal})`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length < 4) return;
      const length = stdout.readUInt32BE(0);
      if (stdout.length < length + 4) return;
      const payload = stdout.subarray(4, length + 4);
      if (payload[0] !== 0x12 || !payload.includes(Buffer.from("workspace.watch"))) {
        finish(new Error("agent hello is missing workspace.watch capability"));
        return;
      }
      finish();
    });
    child.stdin.write(CLIENT_HELLO_FRAME);
  });
}
