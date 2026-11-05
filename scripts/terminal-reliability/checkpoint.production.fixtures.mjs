export const productionFixtures = [
  { name: "application-input", prefix: "\x1b[?1h\x1b[?2004h\x1b[?1003h\x1b[?1006h", suffix: "TUI" },
  {
    name: "color-scheme",
    prefix: "\x1b[?2031h",
    suffix: "\x1b[?996n\x1b]11;#ffffff\x1b\\\x1b]10;#000000\x1b\\\x1b]111\x1b\\\x1b[?996n",
  },
  { name: "split-csi", prefix: "hello\x1b[3", suffix: "2mTUI\x1b[6n" },
  { name: "split-zwj", prefix: "👩\u200d", suffix: "👩\u200d👧\u200d👦x\x1b[6n" },
  { name: "split-surrogate", prefix: "A\ud83d", suffix: "\ude00界e\u0301" },
  { name: "osc-builder", prefix: "\x1b]2;partial-title", suffix: "-tail\x1b\\ok" },
  { name: "dcs-builder", prefix: "\x1bP$q", suffix: "m\x1b\\ok" },
  { name: "ignored-apc-tail", prefix: "\x1b_Gsynthetic", suffix: "tail\x1b\\ok" },
  {
    name: "saved-modes-charsets",
    prefix: "\x1b[2;5r\x1b[?6h\x1b(0\x1b[?7l\x1b7\x1b(B\x1b[?6l\x1b[?7h",
    suffix: "\x1b8qqqq\x1b[6n",
  },
  {
    name: "alternate-return",
    prefix: "normal界\x1b[?1049h\x1b[Halt\x1b[?2004h\x1b[?1003h\x1b[?1006h",
    suffix: "\x1b[?1049l!\x1b[6n",
  },
  {
    name: "active-link",
    prefix: "\x1b]8;id=one;https://example.invalid\x1b\\linked",
    suffix: "-tail\x1b]8;;\x1b\\\r\nplain",
  },
  {
    name: "partial-link",
    prefix: "\x1b]8;id=two;https://example.",
    suffix: "invalid\x1b\\link\x1b]8;;\x1b\\",
  },
  {
    name: "link-trim",
    prefix: "\x1b]8;;https://example.invalid\x1b\\linked\x1b]8;;\x1b\\",
    suffix: "\r\n".repeat(5010) + "tail",
  },
  {
    name: "colors",
    prefix: "\x1b]4;1;#123456\x1b\\\x1b]11;#445566\x1b\\",
    suffix:
      "\x1b]4;1;?\x1b\\\x1b]11;?\x1b\\\x1b]104;1\x1b\\\x1b]111\x1b\\\x1b]4;1;?\x1b\\\x1b]11;?\x1b\\",
  },
  { name: "partial-color", prefix: "\x1b]11;#aa", suffix: "bbcc\x1b\\\x1b]11;?\x1b\\" },
  {
    name: "wrap-and-attributes",
    prefix: "\x1b[38;2;12;34;56;48;5;42m" + "界".repeat(10),
    suffix: "x\r\n\x1b[0mend",
  },
];

for (let split = 1; split <= 3; split++)
  productionFixtures.push({
    name: `utf8-carry-${split}`,
    prefix: [0xf0, 0x9f, 0x98, 0x80].slice(0, split),
    suffix: [...[0xf0, 0x9f, 0x98, 0x80].slice(split), 0x78],
  });
const cutStream =
  "\x1b]8;id=cut;https://example.invalid\x1b\\👩\u200d👧\x1b]8;;\x1b\\\x1b]11;#123456\x1b\\\x1b[?1049h\x1b[2;5r\x1b[?6h\x1b7\x1b[?6l\x1b8\x1b[?1049l\x1b[6n";
for (let index = 1; index <= 32; index++) {
  const cut = Math.floor((index * cutStream.length) / 33);
  productionFixtures.push({
    name: `deterministic-cut-${index}`,
    prefix: cutStream.slice(0, cut),
    suffix: cutStream.slice(cut),
  });
}

/** Independent observable projection, deliberately not implemented with capture helpers. */
export function productionOracle(terminal) {
  const core = terminal._core;
  return {
    active: terminal.buffer.active.type,
    modes: { ...terminal.modes },
    coreModes: { ...core.coreService.decPrivateModes },
    buffers: [terminal.buffer.normal, terminal.buffer.alternate].map((buffer) => ({
      cursor: [buffer.cursorX, buffer.cursorY, buffer.baseY, buffer.viewportY],
      lines: Array.from({ length: buffer.length }, (_, i) => {
        const line = buffer.getLine(i);
        return {
          wrapped: line.isWrapped,
          cells: Array.from({ length: line.length }, (_, x) => {
            const cell = line.getCell(x);
            return [
              cell.getChars(),
              cell.getWidth(),
              cell.getFgColorMode(),
              cell.getFgColor(),
              cell.getBgColorMode(),
              cell.getBgColor(),
              cell.isBold(),
              cell.isItalic(),
              cell.isUnderline(),
              cell.extended?._ext ?? 0,
              cell.extended?._urlId ?? 0,
            ];
          }),
        };
      }),
    })),
    links: Array.from(core._oscLinkService._dataByLinkId, ([id, entry]) => ({
      id,
      data: { ...entry.data },
      lines: entry.lines.map((marker) => ({
        buffer: core.buffers.normal.markers.includes(marker) ? "normal" : "alternate",
        line: marker.line,
      })),
    })),
    title: core._inputHandler._windowTitle,
  };
}
