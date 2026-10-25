// Independent selected-state oracle. It imports neither the schema nor codec
// nor capture/apply code, and reads uninterrupted xterm services directly.
// Array expansion is only for SMALL differential fixtures, never max-memory runs.
/* eslint-disable unicorn/consistent-function-scoping -- This function is embedded verbatim as a standalone browser oracle, with no imported closure. */
export function referenceState(terminal, includeLines = true) {
  const c = terminal._core,
    h = c._inputHandler,
    p = h._parser;
  const pick = (object, fields) =>
    Object.fromEntries(fields.split(" ").map((key) => [key, object[key]]));
  const normalize = (value) => {
    if (value == null || typeof value !== "object") return value;
    if (ArrayBuffer.isView(value)) return Array.from(value);
    if (Array.isArray(value)) return value.map(normalize);
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, normalize(value[key])]),
    );
  };
  const control = (parser) => ({
    fields: pick(parser, "_state _id _ident _stack"),
    handlers: Object.entries(parser._handlers).map(([id, list]) => [
      id,
      list.map((handler) => pick(handler, "_data _params _hitLimit")),
    ]),
    active: parser._active.map((handler) => {
      for (const [id, list] of Object.entries(parser._handlers)) {
        const index = list.indexOf(handler);
        if (index >= 0) return [id, index];
      }
      throw new Error("reference unknown active handler");
    }),
  });
  return normalize({
    buffers: [c._bufferService.buffers.normal, c._bufferService.buffers.alt].map((buffer) => ({
      fields: pick(
        buffer,
        "ydisp ybase x y scrollTop scrollBottom tabs savedX savedY savedCurAttrData savedCharset _cols _rows _hasScrollback",
      ),
      lines: includeLines
        ? Array.from({ length: buffer.lines.length }, (_, index) => {
            const line = buffer.lines.get(index);
            if (
              Object.keys(line).toSorted().join() !==
              "_combined,_data,_extendedAttrs,isWrapped,length"
            )
              throw new Error("independent BufferLine field coverage changed");
            return pick(line, "_data _combined _extendedAttrs length isWrapped");
          })
        : buffer.lines.length,
      maxLength: buffer.lines.maxLength,
    })),
    active: c._bufferService.buffers.active === c._bufferService.buffers.alt ? 1 : 0,
    bufferService: pick(c._bufferService, "cols rows isUserScrolling"),
    handler: pick(
      h,
      "_windowTitle _iconName _windowTitleStack _iconNameStack _curAttrData _eraseAttrDataInternal",
    ),
    stringCarry: h._stringDecoder._interim,
    utf8Carry: Array.from(h._utf8Decoder.interim),
    parser: pick(p, "initialState currentState precedingJoinState _params _collect"),
    osc: control(p._oscParser),
    dcs: control(p._dcsParser),
    charset: pick(c._charsetService, "charset glevel _charsets"),
    modes: {
      ...pick(c.coreService, "modes decPrivateModes isCursorInitialized isCursorHidden"),
      decPrivateModes: {
        ...c.coreService.decPrivateModes,
        cursorStyle: c.coreService.decPrivateModes.cursorStyle,
        cursorBlink: c.coreService.decPrivateModes.cursorBlink,
      },
    },
    mouse: {
      ...pick(c.coreMouseService, "_activeProtocol _activeEncoding _lastEvent _wheelPartialScroll"),
      _lastEvent:
        c.coreMouseService._lastEvent === null
          ? null
          : pick(c.coreMouseService._lastEvent, "col row x y button action ctrl alt shift"),
    },
    nextLinkId: c._oscLinkService._nextId,
    links: Array.from(c._oscLinkService._dataByLinkId, ([id, entry]) => [
      id,
      {
        data: entry.data,
        key: entry.key,
        lines: entry.lines.map((marker) => [
          c._bufferService.buffers.normal.markers.includes(marker) ? 0 : 1,
          marker.line,
        ]),
      },
    ]),
  });
}
