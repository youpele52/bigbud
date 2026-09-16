import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [root, mode, parentToken] = process.argv.slice(2);
if (!root || !mode) throw new Error("Missing worker arguments");

if (mode === "choosing") {
  const original = fs.readdir;
  let paused = false;
  fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
    if (!paused && String(args[0]).endsWith(`${path.sep}slots`)) {
      paused = true;
      const resume = once(process, "message");
      process.send?.({ event: "choosing" });
      await resume;
    }
    return original(...args);
  }) as typeof fs.readdir;
  // Pause the actual bakery after atomic choosing publication, before its scan.
  syncBuiltinESMExports();
}

const { createDevPortCoordinator, reserveDevPort } = (await import(
  new URL("./DevPortCoordinator.ts", import.meta.url).href
)) as typeof import("./DevPortCoordinator");
const coordinator = await createDevPortCoordinator(root, path.join(root, "storage"));

if (mode === "stress") {
  const start = once(process, "message");
  process.send?.({ event: "ready" });
  await start;
  for (let index = 0; index < 15; index++) {
    await coordinator.withLock(async () => {
      const guard = path.join(root, "critical");
      const file = await fs.open(guard, "wx");
      try {
        const count = Number(await fs.readFile(path.join(root, "counter"), "utf8"));
        await delay(2);
        await fs.writeFile(path.join(root, "counter"), String(count + 1));
      } finally {
        await file.close();
        await fs.unlink(guard);
      }
    });
  }
} else if (mode === "reserve") {
  const lease = await coordinator.withLock(() =>
    reserveDevPort(coordinator, 5733, "web", parentToken),
  );
  const stop = once(process, "message");
  process.send?.({ event: "reserved", reservation: lease.reservation });
  await stop;
  await lease.release();
} else if (mode === "hold" || mode === "choosing") {
  await coordinator.withLock(async () => {
    const stop = once(process, "message");
    process.send?.({ event: "locked" });
    await stop;
  });
} else {
  throw new Error(`Unknown worker mode: ${mode}`);
}
process.disconnect?.();
