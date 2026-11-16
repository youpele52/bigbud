import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { publicationFixture } from "../remote-agent/mobileOptionalPublication.test-fixtures.ts";
import {
  prepareMobileGatewayAssets,
  mobileGatewayAssetsPath,
  removeMobileGatewayAssets,
  armMobileGatewayAssetsTransfer,
  markMobileGatewayAssetsLaunched,
} from "./mobileGatewayProcess.assets.ts";
import { writeMobileGatewayAssetsReceipt } from "./mobileGatewayAssets.receipt.ts";
import {
  canonicalMobileAssetsReceipt,
  mobileAssetsReceiptPathDigest,
} from "./mobileGatewayAssets.receipt.format.ts";

const wiring = vi.hoisted(() => ({
  afterHash: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock("./mobileGatewayAssets.receipt.files.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mobileGatewayAssets.receipt.files.ts")>();
  return {
    ...actual,
    hashMobileRuntimeFile: async (...args: Parameters<typeof actual.hashMobileRuntimeFile>) => {
      const hash = await actual.hashMobileRuntimeFile(...args);
      await wiring.afterHash?.(args[0].path);
      return hash;
    },
  };
});
const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  wiring.afterHash = undefined;
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture();
  fixtures.push(f);
  return f;
}
it("produces durable immutable receipt data from original assets without changing CAS", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      assets = await prepareMobileGatewayAssets(
        proof,
        "receipt-attempt",
        new AbortController().signal,
      );
    const path = mobileGatewayAssetsPath(assets),
      before = f.read();
    const ref = await writeMobileGatewayAssetsReceipt(proof, assets);
    const bytes = await fs.readFile(`${path}.receipt.json`),
      file = await fs.lstat(`${path}.receipt.json`, { bigint: true });
    expect(bytes.length).toBe(ref.sizeBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.sha256);
    const decoded: unknown = JSON.parse(bytes.toString("utf8"));
    expect(canonicalMobileAssetsReceipt(decoded)).toEqual(bytes);
    expect(bytes.toString("utf8")).toContain(mobileAssetsReceiptPathDigest("", "directory"));
    expect(file.mode & 0o7777n).toBe(0o600n);
    expect(file.nlink).toBe(1n);
    expect(f.read()).toEqual(before);
    expect(await writeMobileGatewayAssetsReceipt(proof, assets)).toEqual(ref);
    expect((await fs.lstat(`${path}.receipt.json`, { bigint: true })).ino).toBe(file.ino);
    await expect(writeMobileGatewayAssetsReceipt(proof, { ...assets })).rejects.toThrow(/Original/);
    await removeMobileGatewayAssets(proof, assets);
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(`${path}.receipt.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
it("preserves foreign receipt collisions and assets instead of overwriting/adopting", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      assets = await prepareMobileGatewayAssets(
        proof,
        "receipt-collision",
        new AbortController().signal,
      ),
      path = mobileGatewayAssetsPath(assets);
    await fs.writeFile(`${path}.receipt.json`, "foreign", { flag: "wx", mode: 0o600 });
    await expect(writeMobileGatewayAssetsReceipt(proof, assets)).rejects.toMatchObject({
      code: "EEXIST",
    });
    await expect(removeMobileGatewayAssets(proof, assets)).rejects.toThrow(/Incomplete receipt/);
    expect(await fs.readFile(`${path}.receipt.json`, "utf8")).toBe("foreign");
    expect(await fs.readFile(join(path, "index.html"), "utf8")).toContain("fixture");
  });
});
it("refuses same-inode source mutation during streamed content hashing", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      assets = await prepareMobileGatewayAssets(
        proof,
        "receipt-mutation",
        new AbortController().signal,
      ),
      path = mobileGatewayAssetsPath(assets);
    wiring.afterHash = async (file) => {
      wiring.afterHash = undefined;
      await fs.appendFile(file, "foreign");
    };
    await expect(writeMobileGatewayAssetsReceipt(proof, assets)).rejects.toThrow(/changed/);
    await expect(fs.lstat(`${path}.receipt.json`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(path, "index.html"), "utf8")).toContain("foreign");
  });
});
it("preserves substituted receipt bytes and its complete original tree", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      assets = await prepareMobileGatewayAssets(
        proof,
        "receipt-foreign",
        new AbortController().signal,
      ),
      path = mobileGatewayAssetsPath(assets);
    await writeMobileGatewayAssetsReceipt(proof, assets);
    await fs.writeFile(`${path}.receipt.json`, "foreign replacement");
    await expect(removeMobileGatewayAssets(proof, assets)).rejects.toThrow(/Receipt/);
    expect(await fs.readFile(join(path, "index.html"), "utf8")).toContain("fixture");
    expect(await fs.readFile(`${path}.receipt.json`, "utf8")).toBe("foreign replacement");
  });
});
it("arms preservation before unknown reserve/start and never disarms from a lease boolean or JSON", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      assets = await prepareMobileGatewayAssets(
        proof,
        "receipt-transfer",
        new AbortController().signal,
      ),
      path = mobileGatewayAssetsPath(assets);
    const ref = await writeMobileGatewayAssetsReceipt(proof, assets);
    armMobileGatewayAssetsTransfer(assets);
    expect(() => armMobileGatewayAssetsTransfer({ ...assets })).toThrow(/Original/);
    expect(() => markMobileGatewayAssetsLaunched(assets)).toThrow(/Native transfer/);
    await expect(removeMobileGatewayAssets(proof, assets)).rejects.toThrow(/Native transfer/);
    expect((await fs.stat(`${path}.receipt.json`)).size).toBe(ref.sizeBytes);
    expect(await fs.readFile(join(path, "index.html"), "utf8")).toContain("fixture");
  });
});

it("preserves an armed original generation even before any receipt or native ACK exists", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      assets = await prepareMobileGatewayAssets(
        proof,
        "receipt-no-ack",
        new AbortController().signal,
      ),
      path = mobileGatewayAssetsPath(assets);
    armMobileGatewayAssetsTransfer(assets);
    await expect(writeMobileGatewayAssetsReceipt(proof, assets)).rejects.toThrow(/transfer armed/);
    await expect(removeMobileGatewayAssets(proof, assets)).rejects.toThrow(/Native transfer/);
    await expect(fs.lstat(`${path}.receipt.json`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(path, "index.html"), "utf8")).toContain("fixture");
  });
});
it("does not arm transfer while accepted Node cleanup is still queued", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      assets = await prepareMobileGatewayAssets(
        proof,
        "receipt-cleanup-race",
        new AbortController().signal,
      );
    const cleaning = removeMobileGatewayAssets(proof, assets);
    expect(() => armMobileGatewayAssetsTransfer(assets)).toThrow(/cleanup/);
    await cleaning;
  });
});

it("fences transfer and direct launch until an accepted receipt hash job settles", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      assets = await prepareMobileGatewayAssets(
        proof,
        "receipt-busy",
        new AbortController().signal,
      );
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hashing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    wiring.afterHash = async () => {
      wiring.afterHash = undefined;
      entered();
      await held;
    };
    const receipt = writeMobileGatewayAssetsReceipt(proof, assets);
    // Admission is synchronous, even before the queued publisher operation starts.
    expect(() => armMobileGatewayAssetsTransfer(assets)).toThrow(/receipt publication/);
    expect(() => markMobileGatewayAssetsLaunched(assets)).toThrow(/receipt publication/);
    await hashing;
    try {
      expect(() => armMobileGatewayAssetsTransfer(assets)).toThrow(/receipt publication/);
    } finally {
      release();
    }
    await receipt;
    // Rejected arm never changes the restrictive transfer state.
    await writeMobileGatewayAssetsReceipt(proof, assets);
    await removeMobileGatewayAssets(proof, assets);
  });
});
