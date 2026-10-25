import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Frozen official upstream inputs, independent of the production capability manifest.
// Usage: node SharedService.official.generate.mjs <official 2.0.24 openapi.json> <official 2.0.26 openapi.json>
const sources = {
  "2.0.24": {
    commit: "e7a34f09bfd9134dfade5a8ddb843f7030bc9a69",
    sha256: "0612418392961ef22f0337ce0e1e520270917665fc85f29c4af1c94d1e1873ee",
  },
  "2.0.26": {
    commit: "9b4ec5714d481559990db0a816d5dec19541a814",
    sha256: "17951689576c124f66a8b0270d759429f46d2235293b1ec228e889994ac56e5b",
  },
};
const operations = new Set([
  "server.info",
  "agent.list",
  "skill.list",
  "model.list",
  "provider.list",
  "integration.list",
  "mcp.list",
  "session.list",
  "session.create",
  "session.active",
  "session.get",
  "session.update",
  "session.switchModel",
  "session.prompt",
  "session.interrupt",
  "session.message.list",
  "session.inbox.list",
  "session.inbox.cancel",
  "experimental.session.instructions.entry.list",
  "experimental.session.instructions.entry.put",
  "experimental.session.instructions.entry.remove",
  "permission.saved.list",
  "session.permission.list",
  "session.permission.get",
  "session.permission.reply",
  "session.form.list",
  "session.form.get",
  "session.form.reply",
  "session.form.cancel",
  "event.subscribe",
]);
const inputs = process.argv.slice(2);
const fixtures = [];
for (const [version, source] of Object.entries(sources)) {
  const file = inputs[fixtures.length];
  if (!file) throw new Error("Expected both pinned official source files.");
  const bytes = readFileSync(file);
  if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
    throw new Error("Official source integrity mismatch.");
  const document = JSON.parse(bytes);
  const paths = {};
  const schemas = new Map();
  const found = new Set();
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      const prefix = "#/components/schemas/";
      if (!value.$ref.startsWith(prefix)) throw new Error("Unexpected non-schema reference.");
      const name = value.$ref.slice(prefix.length);
      if (!schemas.has(name)) {
        const schema = document.components.schemas[name];
        if (!schema) throw new Error("Missing official schema reference.");
        schemas.set(name, schema);
        visit(schema);
      }
    }
    for (const child of Object.values(value)) visit(child);
  }
  for (const [route, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!operations.has(operation.operationId)) continue;
      (paths[route] ??= {})[method] = operation;
      found.add(operation.operationId);
      visit(operation);
    }
  }
  if (found.size !== operations.size) throw new Error("Required official operation missing.");
  // One independent upstream object per NDJSON record avoids giant formatted code files.
  // All schema/request semantics are copied verbatim, not reconstructed from our implementation.
  const records = [
    {
      kind: "provenance",
      version,
      ...source,
      openapi: document.openapi,
      url: `https://raw.githubusercontent.com/anomalyco/opencode/${source.commit}/packages/protocol/openapi.json`,
    },
    ...Object.entries(paths).map(([name, value]) => ({ kind: "path", name, value })),
    ...[...schemas].map(([name, value]) => ({ kind: "schema", name, value })),
  ];
  if (records.length > 400)
    throw new Error(
      "Split the fixture generator output by concern before growing beyond 400 records.",
    );
  fixtures.push(records);
}
if (JSON.stringify(fixtures[0].slice(1)) !== JSON.stringify(fixtures[1].slice(1)))
  throw new Error(
    "Official consumed closures diverged; split fixtures by version instead of deduplicating.",
  );
const records = [fixtures[0][0], fixtures[1][0], ...fixtures[0].slice(1)];
writeFileSync(
  new URL("./SharedService.official.ndjson", import.meta.url),
  records.map((record) => JSON.stringify(record)).join("\n") + "\n",
);
