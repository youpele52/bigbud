let updateQuiescing = false;
let processTreeUncertainty: Error | null = null;
const pendingStarts = new Set<Promise<unknown>>();

export function beginInstalledProcessQuiescence(): void {
  updateQuiescing = true;
}

export function isInstalledProcessQuiescing(): boolean {
  return updateQuiescing;
}

export function assertInstalledProcessStartsAllowed(processDescription: string): void {
  if (updateQuiescing) {
    throw new Error(`${processDescription} cannot start while update installation is preparing.`);
  }
}

export function recordInstalledProcessTreeUncertainty(error: Error): void {
  if (updateQuiescing && !processTreeUncertainty) processTreeUncertainty = error;
}

export function getInstalledProcessTreeUncertainty(): Error | null {
  return processTreeUncertainty;
}

export async function trackInstalledProcessStart<T>(operation: () => Promise<T>): Promise<T> {
  assertInstalledProcessStartsAllowed("Installed process");
  const request = operation();
  pendingStarts.add(request);
  try {
    return await request;
  } finally {
    pendingStarts.delete(request);
  }
}

export async function waitForInstalledProcessStarts(): Promise<void> {
  while (pendingStarts.size > 0) {
    await Promise.allSettled(pendingStarts);
  }
}
