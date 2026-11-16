import { ChildProcess, spawn } from "node:child_process";

/** Preserve native overloads/options while observing only the original returned OS child handle. */
export function mobileGatewayOwnedSpawn(capture: (child: ChildProcess) => void): typeof spawn {
  return new Proxy(spawn, {
    apply(target, thisArg, args) {
      const result: unknown = Reflect.apply(target, thisArg, args);
      if (!(result instanceof ChildProcess))
        throw Error("Gateway spawn did not return an original child handle.");
      capture(result);
      return result;
    },
  });
}
export async function awaitMobileGatewayClose(
  closed: Promise<void>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
