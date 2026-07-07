function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMcpServerStatusEntries(value: unknown): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];

  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }

    if (!candidate || typeof candidate !== "object") {
      return;
    }

    const record = candidate as Record<string, unknown>;
    if (typeof record.name === "string") {
      entries.push(record);
    }

    for (const nested of Object.values(record)) {
      visit(nested);
    }
  };

  visit(value);
  return entries;
}

export function hasReadyMcpServers(
  value: unknown,
  expectedServerNames: ReadonlyArray<string>,
): boolean {
  if (expectedServerNames.length === 0) {
    return true;
  }

  const expected = new Set(expectedServerNames);
  const ready = new Set<string>();

  for (const entry of readMcpServerStatusEntries(value)) {
    const name = typeof entry.name === "string" ? entry.name : undefined;
    if (!name || !expected.has(name)) {
      continue;
    }

    const tools = Array.isArray(entry.tools) ? entry.tools : undefined;
    if (tools && tools.length > 0) {
      ready.add(name);
      continue;
    }

    const startupStatus =
      typeof entry.startupStatus === "string"
        ? entry.startupStatus.toLowerCase()
        : typeof entry.status === "string"
          ? entry.status.toLowerCase()
          : typeof entry.state === "string"
            ? entry.state.toLowerCase()
            : undefined;
    if (
      startupStatus === "ready" ||
      startupStatus === "running" ||
      startupStatus === "connected" ||
      startupStatus === "ok" ||
      startupStatus === "completed"
    ) {
      ready.add(name);
    }
  }

  return expectedServerNames.every((name) => ready.has(name));
}

export { sleep };
