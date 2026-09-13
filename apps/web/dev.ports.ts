import { isDevPortAvailable } from "@bigbud/shared/DevPortAvailability";
import {
  createDevPortCoordinator,
  readDevPortReservations,
  reserveDevPort,
} from "@bigbud/shared/DevPortCoordinator";

type Coordinator = Awaited<ReturnType<typeof createDevPortCoordinator>>;

export async function reserveWebDevPort(
  coordinator: Coordinator,
  startPort: number,
  parentToken?: string,
  signal?: AbortSignal,
) {
  return coordinator.withLock(async () => {
    signal?.throwIfAborted();
    const reservations = await readDevPortReservations(coordinator);
    if (parentToken !== undefined) {
      const parent = reservations.find((entry) => entry.token === parentToken);
      if (parent?.kind !== "web" || parent.port !== startPort) {
        throw new Error(`Web development reservation does not match port ${startPort}`);
      }
      // An attached listener must never move away from the runner's advertised URL.
      // reserveDevPort also rejects another live child of this reservation.
      return reserveDevPort(coordinator, startPort, "web", parentToken);
    }
    const reserved = new Set(reservations.map((entry) => entry.port));
    for (let port = startPort; port <= 65535; port++) {
      signal?.throwIfAborted();
      if (reserved.has(port) || !(await isDevPortAvailable(port))) continue;
      signal?.throwIfAborted();
      return reserveDevPort(coordinator, port, "web");
    }
    throw new Error(`No web development port available between ${startPort} and 65535`);
  }, signal);
}
