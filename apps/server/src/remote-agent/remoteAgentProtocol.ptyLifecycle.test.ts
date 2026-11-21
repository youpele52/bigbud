import { describe, expect, it } from "vitest";

import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import {
  REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
  REMOTE_AGENT_PROTOCOL_MINOR,
  type RemoteAgentFrame,
} from "./remoteAgentProtocol.ts";
import {
  REMOTE_AGENT_SNAPSHOT_CHUNK_MAX_BYTES,
  REMOTE_AGENT_SNAPSHOT_MAX_CHUNKS,
  REMOTE_AGENT_SNAPSHOT_MAX_ESCAPE_TAIL_BYTES,
  REMOTE_AGENT_SNAPSHOT_MAX_TOTAL_BYTES,
} from "./remoteAgentProtocol.ptyLifecycle.ts";
import {
  fill,
  hexBytes,
  largeGolden,
  lifecycleGoldenFrames,
  lifecycleGoldens,
} from "./remoteAgentProtocol.ptyLifecycle.fixture.ts";

const expectRoundTrip = (bytes: Uint8Array, frame: RemoteAgentFrame) => {
  expect(Buffer.from(encodeDelimitedFrame(frame)).equals(Buffer.from(bytes))).toBe(true);
  expect(decodeDelimitedFrame(bytes)).toEqual(frame);
};

const maxChunk = (index: number, last: boolean): RemoteAgentFrame => ({
  type: "ptyScreenSnapshotChunk",
  value: {
    requestId: "r".repeat(64),
    index,
    last,
    bytes: fill(
      index * REMOTE_AGENT_SNAPSHOT_CHUNK_MAX_BYTES,
      REMOTE_AGENT_SNAPSHOT_CHUNK_MAX_BYTES,
    ),
  },
});

describe("remote-agent protocol 1.9 terminal lifecycle", () => {
  it("advertises protocol minor 9", () => {
    expect(REMOTE_AGENT_PROTOCOL_MINOR).toBe(9);
  });

  it.each(lifecycleGoldenFrames)("matches the shared Rust golden %s", (name, frame) => {
    expectRoundTrip(hexBytes(lifecycleGoldens[name]!), frame);
  });

  it("matches the maximum-size snapshot header golden", () => {
    const frame: RemoteAgentFrame = {
      type: "ptyScreenSnapshotHeader",
      value: {
        requestId: "r".repeat(64),
        ptyId: "p".repeat(64),
        accepted: true,
        errorCode: "",
        throughSequence: Number.MAX_SAFE_INTEGER,
        cols: 0xffff_ffff,
        rows: 0xffff_ffff,
        scrollbackRows: 0xffff_ffff,
        alternateScreen: true,
        fidelity: "trimmed",
        modelState: "invalid",
        chunkCount: REMOTE_AGENT_SNAPSHOT_MAX_CHUNKS,
        totalAnsiBytes: REMOTE_AGENT_SNAPSHOT_MAX_TOTAL_BYTES,
        pendingEscapeTail: fill(0, REMOTE_AGENT_SNAPSHOT_MAX_ESCAPE_TAIL_BYTES),
        sha256: new Uint8Array(32).fill(0xff),
        trimmedRows: 0xffff_ffff,
        errorMessage: "",
      },
    };
    const golden = largeGolden(
      "pty_screen_snapshot_header_max",
      0,
      REMOTE_AGENT_SNAPSHOT_MAX_ESCAPE_TAIL_BYTES,
    );
    expectRoundTrip(golden, frame);
  });

  it("matches the maximum-size chunk goldens for a single chunk and a 3 MiB transfer", () => {
    const single = largeGolden(
      "pty_screen_snapshot_chunk_max",
      0,
      REMOTE_AGENT_SNAPSHOT_CHUNK_MAX_BYTES,
    );
    expectRoundTrip(single, maxChunk(0, true));

    let total = 0;
    for (let index = 0; index < REMOTE_AGENT_SNAPSHOT_MAX_CHUNKS; index += 1) {
      const name = `pty_screen_snapshot_chunk_3mib_${String(index).padStart(2, "0")}`;
      const golden = largeGolden(
        name,
        index * REMOTE_AGENT_SNAPSHOT_CHUNK_MAX_BYTES,
        REMOTE_AGENT_SNAPSHOT_CHUNK_MAX_BYTES,
      );
      expectRoundTrip(golden, maxChunk(index, index + 1 === REMOTE_AGENT_SNAPSHOT_MAX_CHUNKS));
      expect(golden.length).toBeLessThan(REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES / 4);
      total += REMOTE_AGENT_SNAPSHOT_CHUNK_MAX_BYTES;
    }
    expect(total).toBe(REMOTE_AGENT_SNAPSHOT_MAX_TOTAL_BYTES);
  });

  it("decodes pre-1.9 frames without any lifecycle fields", () => {
    const create = decodeDelimitedFrame(hexBytes(lifecycleGoldens.pty_profile_true!));
    expect(create.type).toBe("ptyCreateRequest");
    expect(Object.keys(create.value)).not.toContain("lifecycleManaged");
    const response = decodeDelimitedFrame(hexBytes(lifecycleGoldens.pty_create_unconfirmed!));
    expect(Object.keys(response.value)).not.toContain("limit");
    const list = decodeDelimitedFrame(hexBytes(lifecycleGoldens.pty_list_response!));
    expect(list.type === "ptyListResponse" && Object.keys(list.value.entries[0]!)).not.toContain(
      "activityState",
    );
    const hello = decodeDelimitedFrame(hexBytes(lifecycleGoldens.agent_hello!));
    expect(Object.keys(hello.value)).not.toContain("processId");
  });

  it("encodes absent lifecycle fields exactly as a pre-1.9 client", () => {
    const [, frame] = lifecycleGoldenFrames.find(([name]) => name === "pty_create_lifecycle")!;
    if (frame.type !== "ptyCreateRequest") throw new Error("expected PTY create");
    const {
      evictPtyId: _evict,
      activitySource: _source,
      screenScrollbackRows: _rows,
      spool: _spool,
      localLaunch: _local,
      lifecycleManaged: _managed,
      ...legacy
    } = frame.value;
    const encoded = encodeDelimitedFrame({ type: "ptyCreateRequest", value: legacy });
    expect(Buffer.from(encoded).toString("hex")).toBe(
      "00000034d202310a086372656174652d3112057074792d321a03010203220b776f726b73706163652d3132082f62696e2f7a736840504818",
    );
  });
});
