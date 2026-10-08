import net from "node:net";
const servers = [],
  sockets = new Set();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
};
process.stdin.resume();
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
for (const spec of process.argv.slice(2)) {
  const [bindHost, bindPort, connectHost, connectPort] = spec.split(":");
  const server = net.createServer((socket) => {
    const target = net.connect(Number(connectPort), connectHost);
    sockets.add(socket);
    sockets.add(target);
    socket.pipe(target).pipe(socket);
    socket.on("error", () => target.destroy());
    target.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      target.destroy();
    });
    target.on("close", () => {
      sockets.delete(target);
      socket.destroy();
    });
  });
  servers.push(server);
  server.listen(Number(bindPort), bindHost);
  server.on("error", () => {
    process.exitCode = 1;
    stop();
  });
}
