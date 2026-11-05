import { describe, expect, it, vi } from "vitest";
import { TerminalDeviceQueries } from "./TerminalDeviceQueries";

describe("live terminal device queries", () => {
  it.each([
    "\u001b[c",
    "\u001b[0c",
    "\u001b[00c",
    "\u001b[000c",
    "\u009bc",
    "\u009b0c",
    "\u009b00c",
  ])("answers primary query %j across every chunk boundary", (query) => {
    for (let cut = 0; cut <= query.length; cut++) {
      const reply = vi.fn(() => true);
      const parser = new TerminalDeviceQueries(reply);
      expect(
        parser.receive(`left${query.slice(0, cut)}`) + parser.receive(`${query.slice(cut)}right`),
      ).toBe("leftright");
      expect(reply).toHaveBeenCalledExactlyOnceWith("\u001b[?1;2c");
    }
  });
  it.each(["\u001b[>c", "\u001b[>0c", "\u001b[>00c", "\u001b[>000c", "\u009b>c", "\u009b>000c"])(
    "answers secondary query %j across every chunk boundary and one codepoint at a time",
    (query) => {
      for (let cut = 0; cut <= query.length; cut++) {
        const reply = vi.fn(() => true);
        const parser = new TerminalDeviceQueries(reply);
        expect(
          parser.receive(`left${query.slice(0, cut)}`) + parser.receive(`${query.slice(cut)}right`),
        ).toBe("leftright");
        expect(reply).toHaveBeenCalledExactlyOnceWith("\u001b[>0;276;0c");
      }
      const reply = vi.fn(() => true);
      const parser = new TerminalDeviceQueries(reply);
      expect([...query].map((c) => parser.receive(c)).join("")).toBe("");
      expect(reply).toHaveBeenCalledExactlyOnceWith("\u001b[>0;276;0c");
    },
  );
  it.each([
    "\u001b]0;title \u001b[c\u0007",
    "\u001bPpayload \u001b[>c\u001b\\",
    "\u009d0;title \u001b[c\u009c",
    "\u001b_X\u001b[c\u001b\\",
    "\u001b[6n",
    "\u001b[?1;2c",
    "\u001b[>1c",
    "\u001b[001c",
    "\u001b[>0001c",
    "\u009b001c",
    "\u009b>0001c",
    "\u001b[00;0c",
    "\u001b[>00;0c",
    "\u001b[00:0c",
    "\u001b[>00:0c",
    "\u001b[?00c",
    "\u001b[=00c",
    "\u001b[>>00c",
    "\u001b[00>c",
    "\u001b[00 c",
    "\u001b[>00$c",
    "\u001b[31mred\u001b[0m",
  ])("does not answer embedded strings or stateful/non-query controls %j", (data) => {
    const reply = vi.fn(() => true);
    const parser = new TerminalDeviceQueries(reply);
    expect([...data].map((c) => parser.receive(c)).join("")).toBe(data);
    expect(reply).not.toHaveBeenCalled();
  });
  it.each([
    "\u001b[c",
    "\u001b[0c",
    "\u001b[00c",
    "\u001b[>c",
    "\u001b[>0c",
    "\u001b[>000c",
    "\u009bc",
    "\u009b00c",
    "\u009b>000c",
  ])(
    "preserves every executable C0 effect in %j across all chunk boundaries without renderer replies",
    (query) => {
      const controls = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).filter(
        (char) => !["\u0018", "\u001a", "\u001b"].includes(char),
      );
      controls.push("\u007f");
      for (const control of controls) {
        for (let position = 1; position < query.length; position++) {
          const embedded = query.slice(0, position) + control + query.slice(position);
          for (let cut = 0; cut <= embedded.length; cut++) {
            const reply = vi.fn(() => true);
            const parser = new TerminalDeviceQueries(reply);
            const visible =
              parser.receive(embedded.slice(0, cut)) + parser.receive(embedded.slice(cut));
            expect(visible).toBe(control);
            expect(parser.finish()).toBe("");
            expect(reply).toHaveBeenCalledOnce();
            const rendererReply = vi.fn(() => true);
            new TerminalDeviceQueries(rendererReply).receive(visible);
            expect(rendererReply).not.toHaveBeenCalled();
          }
        }
      }
    },
  );
  it.each(["\u0018", "\u001a"])("%j cancels CSI rather than executing a DA query", (cancel) => {
    for (const prefix of ["\u001b[00", "\u001b[>000", "\u009b00", "\u009b>000"]) {
      const reply = vi.fn(() => true);
      const parser = new TerminalDeviceQueries(reply);
      const canceled = `${prefix}${cancel}c`;
      expect([...canceled].map((char) => parser.receive(char)).join("")).toBe(canceled);
      expect(reply).not.toHaveBeenCalled();
      expect(parser.receive("\u001b[c")).toBe("");
      expect(reply).toHaveBeenCalledOnce();
    }
  });
  it.each(["\u001b[>1", "\u001b(", "\u001b", "\u009b0"])(
    "a new ESC restarts incomplete %j without leaking an unterminated renderer prefix",
    (prefix) => {
      const reply = vi.fn(() => true);
      const parser = new TerminalDeviceQueries(reply);
      expect([...`${prefix}\u001b[c`].map((char) => parser.receive(char)).join("")).toBe("");
      expect(reply).toHaveBeenCalledExactlyOnceWith("\u001b[?1;2c");
      expect(parser.receive("ordinary text")).toBe("ordinary text");
    },
  );
  it("preserves controls once when reply failure leaves the DA for the renderer", () => {
    const reply = vi.fn(() => false);
    const parser = new TerminalDeviceQueries(reply);
    expect(parser.receive("\u001b[\u0007>\n0\rc")).toBe("\u0007\n\r\u001b[>0c");
    expect(reply).toHaveBeenCalledOnce();
  });
  it("never buffers an unbounded run of executable controls", () => {
    const reply = vi.fn(() => true);
    const parser = new TerminalDeviceQueries(reply);
    expect(parser.receive(`\u001b[${"\u0007".repeat(10_000)}`)).toBe("\u0007".repeat(10_000));
    expect(parser.receive("c")).toBe("");
    expect(reply).toHaveBeenCalledOnce();
  });
  it.each([
    "\u001b]",
    "\u001bP",
    "\u001bX",
    "\u001b^",
    "\u001b_",
    "\u009d",
    "\u0090",
    "\u0098",
    "\u009e",
    "\u009f",
  ])("does not interpret embedded-control DA queries in %j string payloads", (introducer) => {
    const reply = vi.fn(() => true);
    const parser = new TerminalDeviceQueries(reply);
    const payload = `${introducer}payload\u001b[00c\u001b[\u0008>\n000c\u009b>000c\u001b\\`;
    expect([...payload].map((char) => parser.receive(char)).join("")).toBe(payload);
    expect(reply).not.toHaveBeenCalled();
    expect(parser.receive("\u001b[c")).toBe("");
    expect(reply).toHaveBeenCalledOnce();
  });
  it("leaves the query untouched when writing a reply fails", () => {
    const parser = new TerminalDeviceQueries(() => false);
    expect(parser.receive("\u001b[c")).toBe("\u001b[c");
  });
  it.each(["\u001b[", "\u001b[>", "\u009b", "\u009b>"])(
    "answers zero padding only within the existing syntax bound for %j",
    (prefix) => {
      const query = `${prefix}${"0".repeat(32 - prefix.length)}c`;
      const overlong = `${prefix}${"0".repeat(33 - prefix.length)}c`;
      for (let cut = 0; cut <= overlong.length; cut++) {
        const reply = vi.fn(() => true);
        const parser = new TerminalDeviceQueries(reply);
        expect(parser.receive(overlong.slice(0, cut)) + parser.receive(overlong.slice(cut))).toBe(
          overlong,
        );
        expect(reply).not.toHaveBeenCalled();
        expect(parser.receive(query)).toBe("");
        expect(reply).toHaveBeenCalledExactlyOnceWith(
          prefix.endsWith(">") ? "\u001b[>0;276;0c" : "\u001b[?1;2c",
        );
        expect(parser.finish()).toBe("");
      }
    },
  );
  it("passes overlong and canceled sequences without unbounded buffering", () => {
    const reply = vi.fn(() => true);
    const parser = new TerminalDeviceQueries(reply);
    const data = `\u001b[${"0".repeat(100)}c\u001b[\u0018text`;
    expect(parser.receive(data)).toBe(data);
    expect(reply).not.toHaveBeenCalled();
    expect(parser.receive("\u001b[c")).toBe("");
    expect(reply).toHaveBeenCalledOnce();
  });
});

it.each(["\u001b", "\u001b[3", "\u009b>0"])(
  "flushes final partial query prefix %j exactly once without a reply",
  (prefix) => {
    const reply = vi.fn(() => true);
    const parser = new TerminalDeviceQueries(reply);
    expect(parser.receive(`before${prefix}`)).toBe("before");
    expect(parser.finish()).toBe(prefix);
    expect(parser.finish()).toBe("");
    expect(reply).not.toHaveBeenCalled();
  },
);
