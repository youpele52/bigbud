import {
  check,
  integer,
  list,
  shape,
  dictionary,
  attributes,
  extended,
} from "./checkpoint.production.validation.mjs";
import { validateParser } from "./checkpoint.production.validateParser.mjs";

function record(value, required, optional = "") {
  check(value && typeof value === "object" && !Array.isArray(value), "record");
  const keys = required.split(" ");
  const allowed = new Set([...keys, ...optional.split(" ")]);
  check(
    keys.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => allowed.has(key)),
    "record fields",
  );
}
function charset(value) {
  if (value === null || value === undefined) return;
  check(
    typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 128,
    "charset",
  );
  for (const [key, char] of Object.entries(value))
    check(key.length <= 2 && typeof char === "string" && char.length <= 32, "charset entry");
}
function charsets(value) {
  list(value, 4);
  value.forEach(charset);
}

export function validateProductionState(terminal, state) {
  shape(
    state,
    "schema exactCapability profile geometry options buffers active service handler attr erase charset core mouse parser links",
  );
  const cols = terminal.cols,
    rows = terminal.rows;
  integer(cols, 2, 1000);
  integer(rows, 1, 500);
  integer(terminal.options.scrollback, 0, 5000);
  list(state.geometry, 2, 2);
  check(state.geometry[0] === cols && state.geometry[1] === rows, "geometry");
  integer(state.active, 0, 1);
  list(state.buffers, 2, 2);
  shape(state.links, "nextId entries");
  integer(state.links.nextId, 1, 4294967295);
  list(state.links.entries, 100_000);
  const ids = new Set();
  for (const entry of state.links.entries) {
    shape(entry, "id data markers");
    integer(entry.id, 1, state.links.nextId - 1);
    check(!ids.has(entry.id), "duplicate link id");
    ids.add(entry.id);
    record(entry.data, "uri", "id");
    check(typeof entry.data.uri === "string" && entry.data.uri.length <= 1024 * 1024, "link URI");
    check(entry.data.id === undefined || typeof entry.data.id === "string", "link label");
    list(entry.markers, 6000);
  }
  state.buffers.forEach((buffer, index) => {
    shape(buffer, "fields savedAttr maxLength lines");
    const f = buffer.fields;
    record(
      f,
      "ydisp ybase x y scrollTop scrollBottom tabs savedX savedY savedCharsets savedGlevel savedOriginMode savedWraparoundMode _cols _rows _hasScrollback",
      "savedCharset",
    );
    const max = rows + (index === 0 ? terminal.options.scrollback : 0);
    check(buffer.maxLength === max, "buffer capacity");
    list(buffer.lines, max);
    check(
      f._cols === cols && f._rows === rows && f._hasScrollback === (index === 0),
      "buffer geometry",
    );
    integer(f.x, 0, cols);
    integer(f.y, 0, rows - 1);
    integer(f.ybase, 0, max);
    integer(f.ydisp, 0, f.ybase);
    check(
      f.ybase + rows <= buffer.lines.length ||
        (index === 1 && state.active === 0 && buffer.lines.length === 0 && f.ybase === 0),
      "buffer line bounds",
    );
    integer(f.scrollTop, 0, rows - 1);
    integer(f.scrollBottom, f.scrollTop, rows - 1);
    integer(f.savedX, 0, 1000);
    integer(f.savedY, 0, 5500);
    integer(f.savedGlevel, 0, 3);
    check(
      typeof f.savedOriginMode === "boolean" && typeof f.savedWraparoundMode === "boolean",
      "saved modes",
    );
    charset(f.savedCharset);
    charsets(f.savedCharsets);
    dictionary(f.tabs, 1001, (tab) => check(tab === true, "tab"));
    attributes(buffer.savedAttr, ids);
    for (const line of buffer.lines) {
      shape(line, "data combined extended length wrapped");
      check(line.length === cols && typeof line.wrapped === "boolean", "line metadata");
      list(line.data, cols * 3, cols * 3);
      for (const word of line.data) integer(word, 0, 4294967295);
      dictionary(line.combined, cols, (text) => check(typeof text === "string", "combined cell"));
      dictionary(line.extended, cols, (attr) => extended(attr, ids));
    }
  });
  for (const entry of state.links.entries)
    for (const marker of entry.markers) {
      shape(marker, "buffer line");
      integer(marker.buffer, 0, 1);
      integer(marker.line, 0, state.buffers[marker.buffer].lines.length - 1);
    }
  shape(state.service, "cols rows isUserScrolling");
  check(
    state.service.cols === cols &&
      state.service.rows === rows &&
      typeof state.service.isUserScrolling === "boolean",
    "buffer service",
  );
  shape(state.handler, "_windowTitle _iconName _windowTitleStack _iconNameStack");
  for (const name of ["_windowTitle", "_iconName"])
    check(typeof state.handler[name] === "string", "title");
  for (const name of ["_windowTitleStack", "_iconNameStack"]) {
    list(state.handler[name], 100_000);
    for (const value of state.handler[name]) check(typeof value === "string", "title stack");
  }
  attributes(state.attr, ids);
  attributes(state.erase, ids);
  record(state.charset, "glevel _charsets", "charset");
  integer(state.charset.glevel, 0, 3);
  charset(state.charset.charset);
  charsets(state.charset._charsets);
  shape(state.core, "modes decPrivateModes isCursorInitialized isCursorHidden kittyKeyboard");
  shape(state.core.modes, "insertMode");
  check(typeof state.core.modes.insertMode === "boolean", "insert mode");
  for (const name of ["isCursorInitialized", "isCursorHidden"])
    check(typeof state.core[name] === "boolean", "cursor flag");
  const modes = state.core.decPrivateModes;
  record(
    modes,
    "applicationCursorKeys applicationKeypad bracketedPasteMode colorSchemeUpdates origin reverseWraparound sendFocus synchronizedOutput win32InputMode wraparound",
    "cursorStyle cursorBlink",
  );
  for (const [key, value] of Object.entries(modes))
    check(
      key === "cursorStyle"
        ? ["block", "underline", "bar"].includes(value)
        : typeof value === "boolean",
      "DEC mode",
    );
  shape(state.core.kittyKeyboard, "flags mainFlags altFlags mainStack altStack");
  for (const name of ["flags", "mainFlags", "altFlags"])
    integer(state.core.kittyKeyboard[name], 0, 2147483647);
  for (const name of ["mainStack", "altStack"]) {
    list(state.core.kittyKeyboard[name], 16);
    for (const flag of state.core.kittyKeyboard[name]) integer(flag, 0, 2147483647);
  }
  shape(state.mouse, "_activeProtocol _activeEncoding");
  check(
    ["NONE", "X10", "VT200", "DRAG", "ANY"].includes(state.mouse._activeProtocol),
    "mouse protocol",
  );
  check(["DEFAULT", "SGR", "SGR_PIXELS"].includes(state.mouse._activeEncoding), "mouse encoding");
  validateParser(terminal._core, state.parser);
}
