import { isDevPortAvailable } from "@bigbud/shared/DevPortAvailability";

// Tests release a probed port and later bind it (or a neighbour) again, often with
// strictPort or during a Vite restart. Ephemeral ports are unsafe for that: macOS hands
// out listen(0)/connect() ports sequentially system-wide, so a released ephemeral port's
// neighbour is the very next port any parallel test process receives. Ports below every
// default ephemeral range (Linux 32768+, macOS/Windows 49152+) are never assigned
// implicitly, so only an explicit bind can claim them between probe and use.
const FIRST_NON_EPHEMERAL_PORT = 20_000;
const NON_EPHEMERAL_PORT_SPAN = 12_000;
// Retry tests advance past the initial candidate; require that headroom to be free too.
const HEADROOM = 3;

async function isFreeWithHeadroom(port: number): Promise<boolean> {
  for (let offset = 0; offset < HEADROOM; offset++) {
    if (!(await isDevPortAvailable(port + offset))) return false;
  }
  return true;
}

export async function coordinatedTestPort(): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = FIRST_NON_EPHEMERAL_PORT + Math.floor(Math.random() * NON_EPHEMERAL_PORT_SPAN);
    if (await isFreeWithHeadroom(port)) return port;
  }
  throw new Error("Could not find a free non-ephemeral test port with room for collision retries");
}
