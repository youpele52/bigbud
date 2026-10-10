#!/usr/bin/env node
// Synthetic protocol fixture only. No models, tools, profile migration, or real credentials.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

if (process.argv.includes("--version")) {
  console.log("opencode v2.0.26");
  process.exit(0);
}

const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`;
delete process.env.OPENCODE_PASSWORD;
const sessions = new Map();
const inbox = new Map();
const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== authorization) {
    response.writeHead(401);
    response.end();
    return;
  }
  const respond = (data) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(data));
  };
  if (request.url === "/api/info") {
    respond({ version: "2.0.26", pid: process.pid, urls: [], paths: { tmp: process.env.HOME } });
    return;
  }
  if (request.url === "/api/event") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
    return;
  }
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : {};
  if (request.url === "/api/session" && request.method === "POST") {
    if (sessions.has(body.id)) {
      response.writeHead(409);
      response.end();
      return;
    }
    const session = {
      ...body,
      projectID: "project_fixture",
      time: { created: 1, updated: 1 },
      cost: 0,
      tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    };
    sessions.set(body.id, session);
    respond({ data: session });
    return;
  }
  const prompt = /^\/api\/session\/(ses[^/]+)\/prompt$/.exec(request.url);
  if (prompt) {
    if (body.resume !== false) {
      response.writeHead(400);
      response.end();
      return;
    }
    const rows = inbox.get(prompt[1]) ?? [];
    const native = rows.find((row) => row.id === body.id) ?? {
      id: body.id,
      sessionID: prompt[1],
      time: { created: 1 },
      type: "user",
      payload: { text: body.text },
      delivery: "queue",
    };
    if (!rows.includes(native)) rows.push(native);
    inbox.set(prompt[1], rows);
    respond({ data: native });
    return;
  }
  const list = /^\/api\/session\/(ses[^/]+)\/inbox$/.exec(request.url);
  if (list) {
    respond({ data: inbox.get(list[1]) ?? [] });
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(path.join(process.env.HOME, "synthetic-history"), "retained");
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
});
process.stdin.resume();
const shutdown = () => {
  server.closeAllConnections();
  server.close();
};
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
