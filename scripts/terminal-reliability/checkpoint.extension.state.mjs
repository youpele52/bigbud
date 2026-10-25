import { isTyped } from "./checkpoint.extension.pages.mjs";
const bufferFields = [
  "ydisp",
  "ybase",
  "x",
  "y",
  "scrollTop",
  "scrollBottom",
  "tabs",
  "savedX",
  "savedY",
  "savedCurAttrData",
  "savedCharset",
  "_cols",
  "_rows",
  "_hasScrollback",
];
const handlerFields = [
  "_windowTitle",
  "_iconName",
  "_windowTitleStack",
  "_iconNameStack",
  "_curAttrData",
  "_eraseAttrDataInternal",
];
const parserFields = ["initialState", "currentState", "precedingJoinState", "_params", "_collect"];
const pick = (value, fields) => Object.fromEntries(fields.map((field) => [field, value[field]]));
const restore = (target, value, fields) => {
  for (const field of fields) target[field] = value[field];
};
const handlers = (map) => Object.entries(map).map(([id, list]) => [id, list.length]);

export function fingerprint(core) {
  const parser = core._inputHandler._parser;
  return JSON.stringify({
    unicode: [core.unicodeService._active, Object.keys(core.unicodeService._providers)],
    csi: handlers(parser._csiHandlers),
    esc: handlers(parser._escHandlers),
    execute: Object.keys(parser._executeHandlers),
    osc: handlers(parser._oscParser._handlers),
    dcs: handlers(parser._dcsParser._handlers),
  });
}

function controlString(parser) {
  const handlers = Object.entries(parser._handlers).map(([id, list]) => [
    id,
    list.map((handler) => pick(handler, ["_data", "_params", "_hitLimit"])),
  ]);
  const active = parser._active.map((handler) => {
    for (const [id, list] of Object.entries(parser._handlers)) {
      const index = list.indexOf(handler);
      if (index !== -1) return [id, index];
    }
    throw new Error("unsupported active parser handler");
  });
  return { fields: pick(parser, ["_state", "_id", "_ident", "_stack"]), handlers, active };
}

function restoreControlString(parser, state) {
  restore(parser, state.fields, ["_state", "_id", "_ident", "_stack"]);
  for (const [id, list] of state.handlers) {
    list.forEach((value, index) =>
      restore(parser._handlers[id][index], value, ["_data", "_params", "_hitLimit"]),
    );
  }
  parser._active = state.preparedActive;
}

export function captureState(core) {
  const buffers = core._bufferService.buffers;
  const handler = core._inputHandler;
  const parser = handler._parser;
  // Browser palette has no matching headless owner in upstream 6.0.0. Refuse,
  // rather than inventing state or calling this prototype full exact capability.
  if (core._oscLinkService._dataByLinkId.size)
    throw new Error("hyperlink marker custody not supported by prototype");
  if (buffers.normal.markers.length || buffers.alt.markers.length)
    throw new Error("external markers not supported");
  return {
    buffers: [buffers.normal, buffers.alt].map((buffer) => ({
      fields: pick(buffer, bufferFields),
      lines: Array.from({ length: buffer.lines.length }, (_, index) => buffer.lines.get(index)),
      maxLength: buffer.lines.maxLength,
    })),
    active: buffers.active === buffers.alt ? 1 : 0,
    bufferService: pick(core._bufferService, ["cols", "rows", "isUserScrolling"]),
    handler: pick(handler, handlerFields),
    stringCarry: handler._stringDecoder._interim,
    utf8Carry: Array.from(handler._utf8Decoder.interim),
    parser: pick(parser, parserFields),
    osc: controlString(parser._oscParser),
    dcs: controlString(parser._dcsParser),
    charset: pick(core._charsetService, ["charset", "glevel", "_charsets"]),
    modes: {
      ...pick(core.coreService, [
        "modes",
        "decPrivateModes",
        "isCursorInitialized",
        "isCursorHidden",
      ]),
      decPrivateModes: {
        ...core.coreService.decPrivateModes,
        cursorStyle: core.coreService.decPrivateModes.cursorStyle,
        cursorBlink: core.coreService.decPrivateModes.cursorBlink,
      },
    },
    mouse: {
      ...pick(core.coreMouseService, [
        "_activeProtocol",
        "_activeEncoding",
        "_lastEvent",
        "_wheelPartialScroll",
      ]),
      _lastEvent:
        core.coreMouseService._lastEvent === null
          ? null
          : pick(core.coreMouseService._lastEvent, [
              "col",
              "row",
              "x",
              "y",
              "button",
              "action",
              "ctrl",
              "alt",
              "shift",
            ]),
    },
    nextLinkId: core._oscLinkService._nextId,
  };
}

export function prepareState(core, state) {
  state.buffers.forEach((saved, index) => {
    const buffer =
      index === 0 ? core._bufferService.buffers.normal : core._bufferService.buffers.alt;
    const lines = new buffer.lines.constructor(saved.maxLength);
    for (const line of saved.lines) lines.push(line);
    saved.preparedLines = lines;
  });
  for (const name of ["osc", "dcs"]) {
    const parser =
      name === "osc"
        ? core._inputHandler._parser._oscParser
        : core._inputHandler._parser._dcsParser;
    state[name].preparedActive = state[name].active.map(
      ([id, index]) => parser._handlers[id][index],
    );
  }
}

export function applyState(core, state) {
  const buffers = core._bufferService.buffers;
  const handler = core._inputHandler;
  const parser = handler._parser;
  [buffers.normal, buffers.alt].forEach((buffer, index) => {
    const saved = state.buffers[index];
    restore(buffer, saved.fields, bufferFields);
    buffer._memoryCleanupQueue.clear();
    buffer._memoryCleanupPosition = 0;
    buffer.lines = saved.preparedLines;
  });
  buffers._activeBuffer = state.active === 1 ? buffers.alt : buffers.normal;
  handler._activeBuffer = buffers.active;
  restore(core._bufferService, state.bufferService, ["cols", "rows", "isUserScrolling"]);
  core._bufferService._cachedBlankLine = undefined;
  restore(handler, state.handler, handlerFields);
  handler._stringDecoder._interim = state.stringCarry;
  handler._utf8Decoder.interim.set(state.utf8Carry);
  restore(parser, state.parser, parserFields);
  restoreControlString(parser._oscParser, state.osc);
  restoreControlString(parser._dcsParser, state.dcs);
  restore(core._charsetService, state.charset, ["charset", "glevel", "_charsets"]);
  restore(core.coreService, state.modes, [
    "modes",
    "decPrivateModes",
    "isCursorInitialized",
    "isCursorHidden",
  ]);
  restore(core.coreMouseService, state.mouse, [
    "_activeProtocol",
    "_activeEncoding",
    "_lastEvent",
    "_wheelPartialScroll",
  ]);
  core._oscLinkService._nextId = state.nextLinkId;
  handler._dirtyRowTracker.markAllDirty();
}

export function samples(core) {
  const handler = core._inputHandler;
  return [
    handler._curAttrData,
    handler._curAttrData.extended,
    core._bufferService.buffers.normal.getBlankLine(handler._curAttrData),
    handler._parser._params,
  ];
}

export function assertQuiescent(core) {
  const handler = core._inputHandler;
  const parser = handler._parser;
  if (
    core._writeBuffer._pendingData ||
    core._writeBuffer._writeBuffer.length ||
    handler._parseStack.paused ||
    parser._parseStack.state ||
    parser._oscParser._stack.paused ||
    parser._dcsParser._stack.paused
  ) {
    throw new Error("checkpoint requires settled writes and asynchronous hooks");
  }
}

export function validateState(state, options) {
  const { cols, rows } = state.bufferService;
  if (
    cols !== options.cols ||
    rows !== options.rows ||
    ![0, 1].includes(state.active) ||
    !Array.isArray(state.buffers) ||
    state.buffers.length !== 2
  )
    throw new Error("invalid geometry/buffers");
  for (const [index, buffer] of state.buffers.entries()) {
    const f = buffer.fields;
    const integers = [
      f.x,
      f.y,
      f.ydisp,
      f.ybase,
      f.scrollTop,
      f.scrollBottom,
      f.savedX,
      f.savedY,
      buffer.maxLength,
    ];
    if (
      integers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      f.x > cols ||
      f.y >= rows ||
      f.scrollTop > f.scrollBottom ||
      f.scrollBottom >= rows ||
      f.ydisp > f.ybase ||
      (f.ybase + rows > buffer.lines.length &&
        !(index === 1 && state.active === 0 && buffer.lines.length === 0 && f.ybase === 0)) ||
      buffer.lines.length > buffer.maxLength ||
      buffer.maxLength > rows + (index === 0 ? options.scrollback : 0) ||
      f._cols !== cols ||
      f._rows !== rows ||
      f._hasScrollback !== (index === 0) ||
      Object.keys(f.tabs).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) > 1000)
    )
      throw new Error("invalid buffer indices");
    for (const line of buffer.lines) {
      if (
        !isTyped(line._data, Uint32Array) ||
        line._data.length !== cols * 3 ||
        line.length !== cols ||
        typeof line.isWrapped !== "boolean"
      )
        throw new Error("invalid buffer line");
    }
  }
  if (
    !Number.isInteger(state.parser.currentState) ||
    state.parser.currentState < 0 ||
    state.parser.currentState > 13 ||
    !Number.isInteger(state.stringCarry) ||
    state.stringCarry < 0 ||
    state.stringCarry > 65535 ||
    state.utf8Carry.length !== 3 ||
    state.utf8Carry.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    throw new Error("invalid parser/decoder state");
  if (state.stringCarry !== 0 && (state.stringCarry < 0xd800 || state.stringCarry > 0xdbff))
    throw new Error("invalid UTF16 carry");
  const [lead, second, third] = state.utf8Carry;
  if (
    lead === 0
      ? second !== 0 || third !== 0
      : lead < 0xc0 ||
        lead > 0xf7 ||
        (second !== 0 && (second < 0x80 || second > 0xbf)) ||
        (third !== 0 && (third < 0x80 || third > 0xbf || second === 0)) ||
        (lead < 0xe0 && (second !== 0 || third !== 0)) ||
        (lead < 0xf0 && third !== 0)
  )
    throw new Error("invalid UTF8 carry");
}
