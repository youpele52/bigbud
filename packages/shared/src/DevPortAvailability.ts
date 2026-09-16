import { createServer } from "node:net";

// NetService.canListenOnHost intentionally collapses fatal errors to false.
// This launcher must surface those errors instead of scanning through every port;
// share this error-preserving probe between the cooperating development launchers.

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.close(() => {
        if (error.code === "EADDRINUSE") resolve(false);
        else if (
          host.includes(":") &&
          (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT")
        )
          resolve(true);
        else reject(error);
      });
    });
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

export async function isDevPortAvailable(port: number): Promise<boolean> {
  // Some platforms allow a wildcard bind alongside a more specific listener.
  // Protect both localhost discovery and wildcard serving. This is advisory:
  // another process may still claim a port before Vite's actual listen call.
  for (const host of ["127.0.0.1", "::1", "0.0.0.0", "::"]) {
    if (!(await canBind(port, host))) return false;
  }
  return true;
}
