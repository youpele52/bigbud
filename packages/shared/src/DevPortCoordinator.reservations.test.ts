import { randomUUID } from "node:crypto";
import { readdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, it, vi } from "vitest";

import {
  readDevPortReservations,
  reserveDevPort,
  type DevPortReservation,
} from "./DevPortCoordinator";
import { setup, worker } from "./DevPortCoordinator.test.helpers";

it("rejects any existing port reservation across kinds and same-process generations", async () => {
  const { coordinator } = await setup();
  await coordinator.withLock(async () => {
    const lease = await reserveDevPort(coordinator, 5733, "web");
    await expect(reserveDevPort(coordinator, 5733, "mobile")).rejects.toThrow("already reserved");
    await expect(reserveDevPort(coordinator, 5733, "web")).rejects.toThrow("already reserved");
    const other = await reserveDevPort(coordinator, 5740, "mobile");
    expect(await readDevPortReservations(coordinator)).toHaveLength(2);
    await other.release();
    await lease.release();
  });
});

it("permits exact web parent attachments and same-PID generations with safe idempotent release", async () => {
  const { coordinator } = await setup();
  const parent = await coordinator.withLock(() => reserveDevPort(coordinator, 5733, "web"));
  const token = parent.reservation.token;
  const first = await coordinator.withLock(() => reserveDevPort(coordinator, 5733, "web", token));
  const next = await coordinator.withLock(() => reserveDevPort(coordinator, 5733, "web", token));
  expect(first.reservation.ownerPid).toBe(process.pid);
  expect(first.reservation.token).not.toBe(next.reservation.token);
  await Promise.all([first.release(), first.release()]);
  await coordinator.withLock(async () => {
    expect(await readDevPortReservations(coordinator)).toEqual(
      expect.arrayContaining([parent.reservation, next.reservation]),
    );
    await expect(reserveDevPort(coordinator, 5734, "web", token)).rejects.toThrow("does not match");
    await expect(reserveDevPort(coordinator, 5733, "mobile", token)).rejects.toThrow("Only web");
    await expect(reserveDevPort(coordinator, 5733, "web", next.reservation.token)).rejects.toThrow(
      "does not match",
    );
  });
  await parent.release();
  await coordinator.withLock(async () => {
    await expect(reserveDevPort(coordinator, 5733, "web", token)).rejects.toThrow("not live");
    await expect(reserveDevPort(coordinator, 5733, "mobile")).rejects.toThrow("already reserved");
  });
  await next.release();
  const replacement = await coordinator.withLock(() => reserveDevPort(coordinator, 5733, "mobile"));
  await Promise.all([first.release(), next.release(), parent.release()]);
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([
    replacement.reservation,
  ]);
});

it("allows one separate child PID, rejects another, and protects a surviving child after parent death", async () => {
  const { root, coordinator } = await setup();
  const parent = worker(root, "reserve");
  const parentRecord = (await parent.message("reserved")).reservation!;
  const child = worker(root, "reserve", parentRecord.token);
  const childRecord = (await child.message("reserved")).reservation!;
  expect(childRecord.ownerPid).not.toBe(parentRecord.ownerPid);
  const competitor = worker(root, "reserve", parentRecord.token);
  expect(await competitor.done).not.toBe(0);
  expect(competitor.stderr).toContain("already reserved");
  await parent.kill();
  await coordinator.withLock(async () => {
    expect(await readDevPortReservations(coordinator)).toEqual([childRecord]);
    await expect(reserveDevPort(coordinator, 5733, "mobile")).rejects.toThrow("already reserved");
    await expect(reserveDevPort(coordinator, 5733, "web", parentRecord.token)).rejects.toThrow(
      "not live",
    );
  });
  await child.kill();
  await coordinator.withLock(async () => {
    expect(await readDevPortReservations(coordinator)).toEqual([]);
    await reserveDevPort(coordinator, 5733, "mobile");
  });
}, 30_000);

it("supports a fresh child PID after the earlier child exits while its parent stays alive", async () => {
  const { root, coordinator } = await setup();
  const parent = await coordinator.withLock(() => reserveDevPort(coordinator, 5733, "web"));
  const first = worker(root, "reserve", parent.reservation.token);
  const old = (await first.message("reserved")).reservation!;
  await first.kill();
  const next = worker(root, "reserve", parent.reservation.token);
  const replacement = (await next.message("reserved")).reservation!;
  expect(replacement.token).not.toBe(old.token);
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual(
    expect.arrayContaining([parent.reservation, replacement]),
  );
});

it("retains old records and uncertain/reused PIDs; only ESRCH permits cleanup", async () => {
  const { coordinator } = await setup();
  const lease = await coordinator.withLock(() => reserveDevPort(coordinator, 5733, "mobile"));
  const filename = path.join(
    coordinator.directory,
    "reservations",
    `${lease.reservation.token}.json`,
  );
  await utimes(filename, new Date(0), new Date(0));
  const kill = vi.spyOn(process, "kill");
  try {
    for (const code of ["EPERM", "EACCES", "UNKNOWN"]) {
      kill.mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
      expect(await readDevPortReservations(coordinator)).toEqual([lease.reservation]);
    }
    kill.mockReturnValue(true);
    expect(await readDevPortReservations(coordinator)).toEqual([lease.reservation]);
    kill.mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(await readDevPortReservations(coordinator)).toEqual([]);
  } finally {
    kill.mockRestore();
  }
});

it.each([0, -1, 65536, 1.5, NaN, Infinity])("rejects invalid port %s", async (port) => {
  const { coordinator } = await setup();
  await expect(
    coordinator.withLock(() => reserveDevPort(coordinator, port, "web")),
  ).rejects.toThrow("between 1 and 65535");
});

it.each([
  { port: 0 },
  { ownerPid: 0 },
  { ownerPid: 2147483648 },
  { token: "../escape" },
  { kind: "other" },
  { parentToken: "invalid" },
  { unexpected: true },
])("fails closed on invalid reservation state %j", async (invalid) => {
  const { coordinator } = await setup();
  const token = `${process.pid}-${randomUUID()}`;
  const filename = path.join(coordinator.directory, "reservations", `${token}.json`);
  await writeFile(
    filename,
    JSON.stringify({ token, port: 5733, kind: "web", ownerPid: process.pid, ...invalid }),
  );
  await expect(
    coordinator.withLock(() => reserveDevPort(coordinator, 5733, "mobile")),
  ).rejects.toThrow();
  expect(await readdir(path.dirname(filename))).toEqual([`${token}.json`]);
});

it("fails closed on malformed, oversized, unknown, or filename-mismatched reservation records", async () => {
  const { coordinator } = await setup();
  const token = `${process.pid}-${randomUUID()}`;
  const record: DevPortReservation = { token, port: 5733, kind: "web", ownerPid: process.pid };
  const filename = path.join(coordinator.directory, "reservations", `${token}.json`);
  for (const content of [
    "{",
    " ".repeat(2049),
    JSON.stringify({ ...record, token: `${process.pid}-${randomUUID()}` }),
  ]) {
    await writeFile(filename, content);
    await expect(
      coordinator.withLock(() => readDevPortReservations(coordinator)),
    ).rejects.toThrow();
    expect(await readFile(filename, "utf8")).toBe(content);
  }
  await writeFile(filename, JSON.stringify(record));
  await writeFile(path.join(coordinator.directory, "reservations", "unknown"), "{}");
  await expect(coordinator.withLock(() => readDevPortReservations(coordinator))).rejects.toThrow(
    "Unknown",
  );
});
