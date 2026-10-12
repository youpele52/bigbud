const validators = new WeakMap<object, () => void>();
const rejectionObservers = new WeakMap<object, () => void>();

/** A local exact-owner observer, not an acknowledgement or new publication permission. */
export function onProviderPublicationRejected(record: object, observe: () => void): void {
  rejectionObservers.set(record, observe);
}

/** Internal authority follows object identity, never serialized contracts or mutable client state. */
export function guardProviderPublication(record: object, validate?: () => void): void {
  if (validate) validators.set(record, validate);
}

/** Stale owned records are discarded individually, without failing a shared provider stream. */
export function validProviderPublication(record: object): boolean {
  try {
    validators.get(record)?.();
    return true;
  } catch {
    const observe = rejectionObservers.get(record);
    rejectionObservers.delete(record);
    try {
      observe?.();
    } catch {
      /* One rejected record must not terminate peer streams. */
    }
    return false;
  }
}

/** Explicitly preserve the original capture when an internal bridge decorates a record. */
export function inheritProviderPublication(source: object, target: object): void {
  guardProviderPublication(target, validators.get(source));
  const observe = rejectionObservers.get(source);
  if (observe) onProviderPublicationRejected(target, observe);
}
