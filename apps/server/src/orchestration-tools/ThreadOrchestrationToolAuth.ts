import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const THREAD_TOOL_AUTH_DIR = "thread-tool-auth";

export interface ThreadOrchestrationToolAuthRecord {
  readonly threadId: string;
  readonly token: string;
  readonly createdAt: string;
}

export function createThreadOrchestrationToolToken(): string {
  return crypto.randomUUID();
}

export function resolveThreadOrchestrationToolAuthPath(input: {
  readonly stateDir: string;
  readonly threadId: string;
}): string {
  return path.join(input.stateDir, THREAD_TOOL_AUTH_DIR, `${input.threadId}.json`);
}

function resolveThreadOrchestrationToolAuthDir(stateDir: string): string {
  return path.join(stateDir, THREAD_TOOL_AUTH_DIR);
}

export async function writeThreadOrchestrationToolAuth(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly token: string;
}): Promise<void> {
  const filePath = resolveThreadOrchestrationToolAuthPath({
    stateDir: input.stateDir,
    threadId: input.threadId,
  });
  await mkdir(resolveThreadOrchestrationToolAuthDir(input.stateDir), { recursive: true });
  const record: ThreadOrchestrationToolAuthRecord = {
    threadId: input.threadId,
    token: input.token,
    createdAt: new Date().toISOString(),
  };
  await writeFile(filePath, JSON.stringify(record), "utf8");
}

export async function readThreadOrchestrationToolAuth(input: {
  readonly stateDir: string;
  readonly threadId: string;
}): Promise<ThreadOrchestrationToolAuthRecord | null> {
  const filePath = resolveThreadOrchestrationToolAuthPath({
    stateDir: input.stateDir,
    threadId: input.threadId,
  });
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ThreadOrchestrationToolAuthRecord>;
    if (
      typeof parsed.threadId !== "string" ||
      typeof parsed.token !== "string" ||
      parsed.threadId !== input.threadId
    ) {
      return null;
    }
    return {
      threadId: parsed.threadId,
      token: parsed.token,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function readThreadOrchestrationToolAuthByToken(input: {
  readonly stateDir: string;
  readonly token: string;
}): Promise<ThreadOrchestrationToolAuthRecord | null> {
  try {
    const authDir = resolveThreadOrchestrationToolAuthDir(input.stateDir);
    const entries = await readdir(authDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const threadId = entry.name.slice(0, -".json".length);
      const record = await readThreadOrchestrationToolAuth({
        stateDir: input.stateDir,
        threadId,
      });
      if (record?.token === input.token) {
        return record;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function isThreadOrchestrationToolAuthorized(input: {
  readonly record: ThreadOrchestrationToolAuthRecord | null;
  readonly threadId: string;
  readonly token: string | null | undefined;
}): boolean {
  if (!input.record || !input.token) {
    return false;
  }
  return input.record.threadId === input.threadId && input.record.token === input.token;
}
