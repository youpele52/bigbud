// Schema 2 is an explicit selected-state contract, not a generic object codec.
// A descriptor fixes every field/type/prototype; dictionaries are only the
// declared charset, tab and cell maps. No checkpoint selects a constructor.
const number = (min, max, integer = true) => ({ kind: "number", min, max, integer });
const bool = { kind: "bool" };
const string = (max = 50 * 1024 * 1024) => ({ kind: "string", max });
const literal = (value) => ({ kind: "literal", value });
const optional = (item) => ({ kind: "optional", item });
const nullable = (item) => ({ kind: "nullable", item });
const list = (item, max, exact) => ({ kind: "list", item, max, exact });
const tuple = (...items) => ({ kind: "tuple", items });
const record = (fields, sample) => ({
  kind: "record",
  fields,
  prototype: sample && Object.getPrototypeOf(sample),
});
const map = (item, max, numeric = true) => ({ kind: "map", item, max, numeric });
const typed = (type, max, exact) => ({ kind: "typed", type, max, exact });
const enumeration = (...values) => ({ kind: "enum", values });
const uint = number(0, 0xffffffff);
const attrBits = number(-0x80000000, 0xffffffff);

export function stateSchema(samples, template) {
  const [attrSample, extSample, lineSample, paramSample] = samples;
  const extended = record({ _ext: attrBits, _urlId: literal(0) }, extSample);
  const attrs = record({ fg: attrBits, bg: attrBits, extended }, attrSample);
  const params = record(
    {
      maxLength: literal(32),
      maxSubParamsLength: literal(32),
      params: typed("i32", 32, 32),
      length: number(0, 32),
      _subParams: typed("i32", 32, 32),
      _subParamsLength: number(0, 32),
      _subParamsIdx: typed("u16", 32, 32),
      _rejectDigits: bool,
      _rejectSubDigits: bool,
      _digitIsSub: bool,
    },
    paramSample,
  );
  const charset = nullable(optional(map(string(32), 128, false)));
  const stack = record({
    paused: literal(false),
    loopPosition: number(-1, 128),
    fallThrough: bool,
  });
  function control(value) {
    return record({
      fields: record({
        _state: value.fields._state === undefined ? literal(undefined) : number(0, 3),
        _id:
          value.fields._id === undefined ? literal(undefined) : number(-1, Number.MAX_SAFE_INTEGER),
        _ident: value.fields._ident === undefined ? literal(undefined) : uint,
        _stack: stack,
      }),
      handlers: tuple(
        ...value.handlers.map(([id, items]) =>
          tuple(
            literal(id),
            tuple(
              ...items.map(() =>
                record({
                  _data: string(),
                  _params: optional(params),
                  _hitLimit: bool,
                }),
              ),
            ),
          ),
        ),
      ),
      active: list(tuple(string(20), number(0, 127)), 128),
    });
  }
  const line = record(
    {
      _data: typed("cells", 3000),
      _combined: map(string(), 1000),
      _extendedAttrs: map(extended, 1000),
      length: number(1, 1000),
      isWrapped: bool,
    },
    lineSample,
  );
  const buffer = record({
    fields: record({
      ydisp: number(0, 10500),
      ybase: number(0, 10500),
      x: number(0, 1000),
      y: number(0, 499),
      scrollTop: number(0, 499),
      scrollBottom: number(0, 499),
      tabs: map(literal(true), 1001),
      savedX: number(0, 1000),
      savedY: number(0, 10500),
      savedCurAttrData: attrs,
      savedCharset: charset,
      _cols: number(1, 1000),
      _rows: number(1, 500),
      _hasScrollback: bool,
    }),
    lines: list(line, 10500),
    maxLength: number(1, 10500),
  });
  return record({
    buffers: tuple(buffer, buffer),
    active: enumeration(0, 1),
    bufferService: record({ cols: number(1, 1000), rows: number(1, 500), isUserScrolling: bool }),
    handler: record({
      _windowTitle: string(),
      _iconName: string(),
      _windowTitleStack: list(string(), 100000),
      _iconNameStack: list(string(), 100000),
      _curAttrData: attrs,
      _eraseAttrDataInternal: attrs,
    }),
    stringCarry: number(0, 65535),
    utf8Carry: list(number(0, 255), 3, 3),
    parser: record({
      initialState: number(0, 13),
      currentState: number(0, 13),
      precedingJoinState: uint,
      _params: params,
      _collect: uint,
    }),
    osc: control(template.osc),
    dcs: control(template.dcs),
    charset: record({ charset, glevel: number(0, 3), _charsets: list(charset, 4) }),
    modes: record({
      modes: record({ insertMode: bool }),
      decPrivateModes: record({
        applicationCursorKeys: bool,
        applicationKeypad: bool,
        bracketedPasteMode: bool,
        origin: bool,
        reverseWraparound: bool,
        sendFocus: bool,
        synchronizedOutput: bool,
        wraparound: bool,
        cursorStyle: optional(enumeration("block", "underline", "bar")),
        cursorBlink: optional(bool),
      }),
      isCursorInitialized: bool,
      isCursorHidden: bool,
    }),
    mouse: record({
      _activeProtocol: enumeration("NONE", "X10", "VT200", "DRAG", "ANY"),
      _activeEncoding: enumeration("DEFAULT", "SGR", "SGR_PIXELS"),
      _lastEvent: nullable(
        record({
          col: number(0, 999),
          row: number(0, 499),
          x: number(0, 1e9, false),
          y: number(0, 1e9, false),
          button: enumeration(0, 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15),
          action: enumeration(0, 1, 2, 3, 32),
          ctrl: optional(bool),
          alt: optional(bool),
          shift: optional(bool),
        }),
      ),
      _wheelPartialScroll: number(-1e9, 1e9, false),
    }),
    nextLinkId: number(1, 0xffffffff),
  });
}
