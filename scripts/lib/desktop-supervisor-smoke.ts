import { spawn } from "node:child_process";

const CLIENT_HELLO_FRAME = Buffer.from(
  "0000002c0a2a080110011a0e636c69656e742d66697874757265221408808040100518d00f2080808008288002309875",
  "hex",
);
const SHUTDOWN_FRAME = Buffer.from("0000000f5a0d0a0b61727469666163745f6f6b", "hex");
const ATTACH_FRAME = Buffer.from(
  "000000271a250a10636f6e73756d65722d6669787475726510071a0d65706f63682d666978747572652029",
  "hex",
);
const BATCH_FRAME = Buffer.from(
  "0000008f328c010a4065626263666463353764643165613662393765643562383762393835636562373132646134643437636462396338333934316233613436633837646662363635120d65706f63682d6669787475726518072210636f6e73756d65722d66697874757265280732230a0d6576656e742d66697874757265102a1a107b2266697874757265223a747275657d",
  "hex",
);

export async function smokeTestDesktopSupervisorBinary(binaryPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let handshaken = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => finish(new Error(`desktop supervisor smoke timed out: ${stderr.trim()}`)),
      5_000,
    );
    child.once("error", finish);
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (handshaken || stdout.length < 4) return;
      const length = stdout.readUInt32BE(0);
      if (length === 0 || length > 1024 * 1024 || stdout.length < length + 4) return;
      const payload = stdout.subarray(4, length + 4);
      if (payload[0] !== 0x12) {
        finish(new Error("desktop supervisor did not return SupervisorHello"));
        return;
      }
      handshaken = true;
      child.stdin.write(SHUTDOWN_FRAME);
      child.stdin.end();
    });
    child.once("exit", (code, signal) => {
      if (!handshaken) {
        finish(new Error(`desktop supervisor exited before handshake (${code}, ${signal})`));
      } else if (code !== 0 || signal !== null) {
        finish(new Error(`desktop supervisor did not shut down cleanly (${code}, ${signal})`));
      } else {
        finish();
      }
    });
    child.stdin.write(CLIENT_HELLO_FRAME);
  });
}

export async function smokeTestDesktopSupervisorRecovery(binaryPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, [], {
      env: { ...process.env, BIGBUD_SUPERVISOR_ACK_TIMEOUT_MS: "50" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let phase: "hello" | "attach" | "batch" | "recovery" | "done" = "hello";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => finish(new Error(`desktop supervisor recovery smoke timed out: ${stderr.trim()}`)),
      5_000,
    );
    child.once("error", finish);
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      while (stdout.length >= 4) {
        const length = stdout.readUInt32BE(0);
        if (length === 0 || length > 1024 * 1024) {
          finish(new Error("desktop supervisor recovery smoke received invalid framing"));
          return;
        }
        if (stdout.length < length + 4) return;
        const payload = stdout.subarray(4, length + 4);
        stdout = stdout.subarray(length + 4);
        if (phase === "hello" && payload[0] === 0x12) {
          phase = "attach";
          child.stdin.write(ATTACH_FRAME);
        } else if (phase === "attach" && payload[0] === 0x22) {
          phase = "batch";
          child.stdin.write(BATCH_FRAME);
        } else if (phase === "batch" && payload[0] === 0x32) {
          phase = "recovery";
        } else if (phase === "recovery" && payload[0] === 0x4a) {
          phase = "done";
          child.stdin.write(SHUTDOWN_FRAME);
          child.stdin.end();
        }
      }
    });
    child.once("exit", (code, signal) => {
      if (phase !== "done" || code !== 0 || signal !== null) {
        finish(new Error(`desktop supervisor recovery smoke failed (${code}, ${signal})`));
      } else {
        finish();
      }
    });
    child.stdin.write(CLIENT_HELLO_FRAME);
  });
}
