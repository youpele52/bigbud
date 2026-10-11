import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Review inventory, NOT a complete checkpoint schema. Fields are verified against pinned sources.
const inventory = {
  "common/buffer/Buffer.ts": [
    "lines",
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
  ],
  "common/buffer/BufferSet.ts": ["_normal", "_alt", "_activeBuffer"],
  "common/buffer/BufferLine.ts": ["_data", "_combined", "_extendedAttrs", "length", "isWrapped"],
  "common/buffer/AttributeData.ts": ["fg", "bg", "_ext", "_urlId"],
  "common/InputHandler.ts": [
    "_stringDecoder",
    "_utf8Decoder",
    "_windowTitle",
    "_iconName",
    "_windowTitleStack",
    "_iconNameStack",
    "_curAttrData",
    "_eraseAttrDataInternal",
    "_activeBuffer",
    "_parseStack",
    "_parseBuffer",
  ],
  "common/input/TextDecoder.ts": ["_interim", "interim"],
  "common/parser/EscapeSequenceParser.ts": [
    "initialState",
    "currentState",
    "precedingJoinState",
    "_params",
    "_collect",
    "_parseStack",
    "_oscParser",
    "_dcsParser",
  ],
  "common/parser/Params.ts": [
    "params",
    "length",
    "_subParams",
    "_subParamsLength",
    "_subParamsIdx",
    "_rejectDigits",
    "_rejectSubDigits",
    "_digitIsSub",
  ],
  "common/parser/OscParser.ts": ["_state", "_active", "_id", "_stack", "_data", "_hitLimit"],
  "common/parser/DcsParser.ts": ["_active", "_ident", "_stack", "_data", "_params", "_hitLimit"],
  "common/services/CoreService.ts": [
    "modes",
    "decPrivateModes",
    "isCursorInitialized",
    "isCursorHidden",
    "wasUserInput",
  ],
  "common/services/CharsetService.ts": ["charset", "glevel", "_charsets"],
  "common/services/UnicodeService.ts": ["_active", "_activeProvider", "_providers"],
  "common/services/CoreMouseService.ts": [
    "_activeProtocol",
    "_activeEncoding",
    "_lastEvent",
    "_wheelPartialScroll",
  ],
  "common/services/OscLinkService.ts": ["_nextId", "_entriesWithId", "_dataByLinkId"],
  "common/services/BufferService.ts": ["cols", "rows", "isUserScrolling", "_cachedBlankLine"],
  "browser/services/ThemeService.ts": ["_colors", "_restoreColors"],
};
const root = new URL("../../apps/web/node_modules/@xterm/xterm/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
if (manifest.version !== "6.0.0") throw new Error("Inventory requires xterm 6.0.0");
const verified = [];
for (const [path, fields] of Object.entries(inventory)) {
  const source = readFileSync(new URL(`src/${path}`, root), "utf8");
  for (const field of fields)
    if (!source.includes(field)) throw new Error(`Missing reviewed field ${path}:${field}`);
  verified.push({ path, fields, sha256: createHash("sha256").update(source).digest("hex") });
}
console.log(
  JSON.stringify(
    {
      version: manifest.version,
      inventory: verified,
      completeSchema: false,
      exactRecoveryGate: "closed",
    },
    null,
    2,
  ),
);
