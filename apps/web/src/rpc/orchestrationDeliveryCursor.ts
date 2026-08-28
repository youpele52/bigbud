const CURSOR_PREFIX = "bigbud:orchestration-delivery-cursor:";

export function readPersistedDeliveryCursor(consumerId: string): number {
  try {
    const value = Number.parseInt(
      window.localStorage.getItem(`${CURSOR_PREFIX}${consumerId}`) ?? "",
      10,
    );
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function persistDeliveryCursor(consumerId: string, sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) return;
  try {
    window.localStorage.setItem(`${CURSOR_PREFIX}${consumerId}`, String(sequence));
  } catch {
    // Browser storage can be unavailable or quota-restricted; the live cursor remains valid.
  }
}
