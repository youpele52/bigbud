import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";

const recordStatus = vi.hoisted(() => vi.fn());
vi.mock("./backendStartupState", () => ({ recordBackendStartupStatus: recordStatus }));

import { listenForBackendStartupStatus } from "./backendStartupStatusPipe";

beforeEach(() => recordStatus.mockReset());

it("parses split and multiple NDJSON status records", () => {
  const stream = new PassThrough();
  listenForBackendStartupStatus(stream, 4);
  stream.write('{"status":"upgrad');
  stream.write('ing"}\nnot-json\n{"status":"ready"}\n');
  expect(recordStatus).toHaveBeenCalledTimes(2);
  expect(recordStatus).toHaveBeenNthCalledWith(1, 4, "upgrading");
  expect(recordStatus).toHaveBeenNthCalledWith(2, 4, "ready");
});

it("bounds an oversized unterminated record and resynchronizes at the next newline", () => {
  const stream = new PassThrough();
  listenForBackendStartupStatus(stream, 8);
  stream.write("x".repeat(20 * 1024));
  stream.write('\n{"status":"starting"}\n');
  expect(recordStatus).toHaveBeenLastCalledWith(8, "starting");
});

it("ignores a single oversized newline-terminated record before parsing the next record", () => {
  const stream = new PassThrough();
  listenForBackendStartupStatus(stream, 12);
  stream.write(`${"x".repeat(20 * 1024)}\n{"status":"ready"}\n`);
  expect(recordStatus).toHaveBeenCalledTimes(1);
  expect(recordStatus).toHaveBeenCalledWith(12, "ready");
});

it("accepts only server safe failure codes and falls back to unknown", () => {
  const stream = new PassThrough();
  listenForBackendStartupStatus(stream, 2);
  stream.write('{"status":"error","reason":"server_runtime_startup_failed"}\n');
  stream.write('{"status":"error","reason":"untrusted error text"}\n');
  expect(recordStatus).toHaveBeenNthCalledWith(1, 2, "error", "server_runtime_startup_failed");
  expect(recordStatus).toHaveBeenNthCalledWith(2, 2, "error", "unknown");
});

it("reports readiness only after an accepted ready status", () => {
  const stream = new PassThrough();
  const onReady = vi.fn();
  listenForBackendStartupStatus(stream, 6, undefined, onReady);
  recordStatus.mockReturnValue(false);
  stream.write('{"status":"starting"}\nnot-json\n');
  stream.write('{"status":"error","reason":"unknown"}\n');
  stream.write('{"status":"ready"}\n');
  expect(onReady).not.toHaveBeenCalled();

  recordStatus.mockReturnValue(true);
  stream.write('{"status":"ready"}\n');
  expect(onReady).toHaveBeenCalledOnce();
});

it("does not report a ready rejected after an accepted error", () => {
  const stream = new PassThrough();
  const onReady = vi.fn();
  recordStatus.mockReturnValueOnce(true).mockReturnValueOnce(false);
  listenForBackendStartupStatus(stream, 9, undefined, onReady);

  stream.write('{"status":"error","reason":"unknown"}\n{"status":"ready"}\n');

  expect(recordStatus).toHaveBeenNthCalledWith(1, 9, "error", "unknown");
  expect(recordStatus).toHaveBeenNthCalledWith(2, 9, "ready");
  expect(onReady).not.toHaveBeenCalled();
});
