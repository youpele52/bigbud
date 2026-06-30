import * as ChildProcess from "node:child_process";

const JSONRPC_VERSION = "2.0";

function writeMessage(
  child: ChildProcess.ChildProcessWithoutNullStreams,
  message: unknown,
): Promise<void> {
  const body = JSON.stringify(message);
  const encoded = Buffer.from(body, "utf8");
  return new Promise((resolve, reject) => {
    child.stdin.write(`Content-Length: ${encoded.length}\r\n\r\n${body}`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function requestResponse(
  child: ChildProcess.ChildProcessWithoutNullStreams,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const cleanup = () => {
      child.stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(`cua-driver mcp exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`),
      );
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const header = buffer.slice(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        const contentLength = Number(match[1]);
        const totalLength = headerEnd + 4 + contentLength;
        if (buffer.length < totalLength) {
          return;
        }
        const body = buffer.slice(headerEnd + 4, totalLength).toString("utf8");
        buffer = buffer.slice(totalLength);
        const message = JSON.parse(body) as Record<string, unknown>;
        if (message.id !== id) {
          continue;
        }
        cleanup();
        if (message.error && typeof message.error === "object") {
          const errorRecord = message.error as Record<string, unknown>;
          reject(
            new Error(
              typeof errorRecord.message === "string"
                ? errorRecord.message
                : "cua-driver returned an MCP error.",
            ),
          );
          return;
        }
        resolve(message.result);
        return;
      }
    };

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    void writeMessage(child, {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params ? { params } : {}),
    }).catch(onError);
  });
}

export async function callCuaDriverTool(
  binaryPath: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const child = ChildProcess.spawn(binaryPath, ["mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  child.stderr.on("data", () => {});

  try {
    await requestResponse(child, 1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "bigbud-desktop", version: "1.0.0" },
    });
    await requestResponse(child, 2, "notifications/initialized");
    return await requestResponse(child, 3, "tools/call", {
      name: toolName,
      arguments: args,
    });
  } finally {
    child.kill("SIGTERM");
  }
}
