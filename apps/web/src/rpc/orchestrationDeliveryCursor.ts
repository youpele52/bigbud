const CURSOR_PREFIX = "bigbud:orchestration-delivery-cursor:";
const DELIVERY_CONSUMER_STORAGE_KEY = "bigbud:orchestration-delivery-consumer";

/** This window's orchestration delivery consumer, created on first use per tab session. */
export function resolveDeliveryConsumerId(): string {
  try {
    const existing = peekDeliveryConsumerId();
    if (existing) return existing;
    const consumerId = crypto.randomUUID();
    window.sessionStorage.setItem(DELIVERY_CONSUMER_STORAGE_KEY, consumerId);
    return consumerId;
  } catch {
    return crypto.randomUUID();
  }
}

/** Reads the consumer id without creating one, e.g. for connection diagnostics. */
export function peekDeliveryConsumerId(): string | null {
  try {
    return window.sessionStorage.getItem(DELIVERY_CONSUMER_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

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
