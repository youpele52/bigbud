// Version-specific isolated wire experiment. No production import or exact-capability claim.
import {
  fields,
  attribute,
  restoreAttribute,
  lineState,
  restoreLine,
} from "./checkpoint.production.values.mjs";
import {
  settled,
  parserProfile,
  captureParser,
  prepareParser,
} from "./checkpoint.production.parser.mjs";
import { captureLinks, prepareLinks } from "./checkpoint.production.links.mjs";
import { admitProductionCapture, scanCheckpointWire } from "./checkpoint.production.budget.mjs";
import {
  decodeProductionCheckpoint,
  admitMaterialization,
} from "./checkpoint.production.validation.mjs";
import { validateProductionState } from "./checkpoint.production.validateState.mjs";

const bufferFields =
  "ydisp ybase x y scrollTop scrollBottom tabs savedX savedY savedCharset savedCharsets savedGlevel savedOriginMode savedWraparoundMode _cols _rows _hasScrollback";
const handlerFields = "_windowTitle _iconName _windowTitleStack _iconNameStack";
const coreFields = "modes decPrivateModes isCursorInitialized isCursorHidden kittyKeyboard";
const optionFields =
  "cols rows scrollback tabStopWidth convertEol windowsMode windowsPty reflowCursorLine scrollOnEraseInDisplay vtExtensions quirks windowOptions termName cursorStyle cursorBlink ignoreBracketedPasteMode";

/** Explicit state selected after reviewing the pinned source; coverage remains a qualification gate. */
export function captureProductionState(terminal, profile) {
  const core = terminal._core;
  settled(core);
  if (parserProfile(core) !== profile) throw new Error("unqualified parser/Unicode profile");
  const handler = core._inputHandler;
  admitProductionCapture(terminal);
  const wire = JSON.stringify({
    schema: "production-experiment-1",
    exactCapability: false,
    profile,
    geometry: [terminal.cols, terminal.rows],
    options: fields(terminal.options, optionFields),
    buffers: [core.buffers.normal, core.buffers.alt].map((buffer) => ({
      fields: fields(buffer, bufferFields),
      savedAttr: attribute(buffer.savedCurAttrData),
      maxLength: buffer.lines.maxLength,
      lines: Array.from({ length: buffer.lines.length }, (_, i) => lineState(buffer.lines.get(i))),
    })),
    active: core.buffers.active === core.buffers.alt ? 1 : 0,
    service: fields(core._bufferService, "cols rows isUserScrolling"),
    handler: fields(handler, handlerFields),
    attr: attribute(handler._curAttrData),
    erase: attribute(handler._eraseAttrDataInternal),
    charset: fields(core._charsetService, "charset glevel _charsets"),
    core: fields(core.coreService, coreFields),
    mouse: fields(core.mouseStateService, "_activeProtocol _activeEncoding"),
    parser: captureParser(core),
    links: captureLinks(core),
  });
  scanCheckpointWire(wire);
  return wire;
}

/** Validate and prepare selected state before commit; complete hostile-input qualification remains open. */
export function restoreProductionState(terminal, wire, profile) {
  const core = terminal._core;
  settled(core);
  const { value: saved, budget } = decodeProductionCheckpoint(wire);
  validateProductionState(terminal, saved);
  if (
    saved.schema !== "production-experiment-1" ||
    saved.exactCapability !== false ||
    saved.geometry[0] !== terminal.cols ||
    saved.geometry[1] !== terminal.rows ||
    saved.profile !== profile ||
    parserProfile(core) !== profile ||
    JSON.stringify(fields(terminal.options, optionFields)) !== JSON.stringify(saved.options)
  )
    throw new Error("incompatible synthetic checkpoint");
  admitMaterialization(saved, budget);
  const state = saved;
  // JSON omits undefined defaults; preserve the fixed upstream mode shape without borrowing target values.
  state.core.decPrivateModes.cursorStyle = state.core.decPrivateModes.cursorStyle ?? undefined;
  state.core.decPrivateModes.cursorBlink = state.core.decPrivateModes.cursorBlink ?? undefined;
  state.charset.charset ??= undefined;
  for (const buffer of state.buffers) buffer.fields.savedCharset ??= undefined;
  const buffers = [core.buffers.normal, core.buffers.alt];
  const Line = buffers[0].lines.get(0).constructor;
  const prepared = state.buffers.map((item, index) => {
    const buffer = buffers[index];
    const lines = new buffer.lines.constructor(item.maxLength);
    for (const line of item.lines) lines.push(restoreLine(buffer, line, Line));
    return lines;
  });
  const savedAttrs = buffers.map((buffer, index) =>
    restoreAttribute(buffer.savedCurAttrData, state.buffers[index].savedAttr),
  );
  const handler = core._inputHandler;
  const attr = restoreAttribute(handler._curAttrData, state.attr);
  const erase = restoreAttribute(handler._eraseAttrDataInternal, state.erase);
  const commitParser = prepareParser(core, state.parser);
  const commitLinks = prepareLinks(core, state.links, prepared);
  // Commit only prepared local objects. All data-dependent validation/allocation is above.
  buffers.forEach((buffer, index) => {
    buffer.clearAllMarkers();
    buffer._memoryCleanupQueue.clear();
    buffer._memoryCleanupPosition = 0;
    Object.assign(buffer, state.buffers[index].fields);
    buffer.savedCurAttrData = savedAttrs[index];
    buffer.lines = prepared[index];
  });
  core.buffers._activeBuffer = buffers[state.active];
  handler._activeBuffer = core.buffers.active;
  Object.assign(core._bufferService, state.service);
  core._bufferService._cachedBlankLine = undefined;
  Object.assign(handler, state.handler);
  handler._curAttrData = attr;
  handler._eraseAttrDataInternal = erase;
  Object.assign(core._charsetService, state.charset);
  Object.assign(core.coreService, state.core);
  Object.assign(core.mouseStateService, state.mouse);
  commitParser();
  commitLinks();
  handler._dirtyRowTracker.markAllDirty();
}

export { parserProfile } from "./checkpoint.production.parser.mjs";
