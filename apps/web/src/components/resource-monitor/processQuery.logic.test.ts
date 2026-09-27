import { describe, expect, it } from "vitest";

import { buildProcessQuery } from "./processQuery.logic";

const controls = { search: " 123 ", status: " running ", sort: "cpu" as const, descending: true };

describe("process query inputs", () => {
  it("uses PID search and preserves the server cursor", () => {
    expect(buildProcessQuery(controls, { generation: 2, digest: "5", offset: 100 })).toEqual({
      pid: 123,
      status: "running",
      sort: "cpu",
      descending: true,
      limit: 100,
      cursor: { generation: 2, digest: "5", offset: 100 },
    });
  });

  it("keeps an oversized numeric input as bounded name text", () => {
    expect(buildProcessQuery({ ...controls, search: "99999999999999" })).toMatchObject({
      name: "99999999999999",
    });
  });

  it("limits filters by UTF-8 bytes before sending them to Rust", () => {
    const query = buildProcessQuery({ ...controls, search: "🔥".repeat(100) });
    expect(query.name).toBe("🔥".repeat(64));
  });
});
