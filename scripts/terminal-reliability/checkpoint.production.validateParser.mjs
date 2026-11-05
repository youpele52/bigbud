import { check, integer, list, shape } from "./checkpoint.production.validation.mjs";
import { captureParser } from "./checkpoint.production.parser.mjs";

export function validateParameters(value) {
  shape(
    value,
    "maxLength maxSubParamsLength length _subParamsLength _rejectDigits _rejectSubDigits _digitIsSub params _subParams _subParamsIdx",
  );
  check(value.maxLength === 32 && value.maxSubParamsLength === 32, "parameter capacities");
  integer(value.length, 0, 32);
  integer(value._subParamsLength, 0, 32);
  for (const name of ["_rejectDigits", "_rejectSubDigits", "_digitIsSub"])
    check(typeof value[name] === "boolean", "parameter flag");
  for (const name of ["params", "_subParams", "_subParamsIdx"]) {
    list(value[name], 32, 32);
    for (const item of value[name])
      integer(
        item,
        name === "_subParamsIdx" ? 0 : -1,
        name === "_subParamsIdx" ? 65535 : 2147483647,
      );
  }
}

export function validateParser(core, state) {
  shape(state, "fields params stringCarry utf8Carry strings");
  shape(state.fields, "initialState currentState precedingJoinState _collect");
  integer(state.fields.initialState, 0, 16);
  integer(state.fields.currentState, 0, 16);
  integer(state.fields.precedingJoinState, 0, 4294967295);
  integer(state.fields._collect, 0, 4294967295);
  validateParameters(state.params);
  integer(state.stringCarry, 0, 65535);
  check(
    state.stringCarry === 0 || (state.stringCarry >= 0xd800 && state.stringCarry <= 0xdbff),
    "UTF16 carry",
  );
  list(state.utf8Carry, 3, 3);
  for (const byte of state.utf8Carry) integer(byte, 0, 255);
  const [lead, second, third] = state.utf8Carry;
  check(
    lead === 0
      ? second === 0 && third === 0
      : lead >= 0xc0 &&
          lead <= 0xf7 &&
          (second === 0 || (second >= 0x80 && second <= 0xbf)) &&
          (third === 0 || (third >= 0x80 && third <= 0xbf && second !== 0)),
    "UTF8 carry",
  );
  const template = captureParser(core);
  list(state.strings, 3, 3);
  state.strings.forEach((saved, index) => {
    const expected = JSON.parse(JSON.stringify(template.strings[index]));
    shape(saved, "fields handlers active");
    shape(saved.fields, Object.keys(expected.fields).join(" "));
    for (const [key, value] of Object.entries(saved.fields)) {
      if (key === "_stack") {
        shape(value, "paused loopPosition fallThrough");
        check(
          value.paused === false && typeof value.fallThrough === "boolean",
          "paused string parser",
        );
        integer(value.loopPosition, -1, 128);
      } else integer(value, -1, 4294967295);
    }
    list(saved.handlers, expected.handlers.length, expected.handlers.length);
    saved.handlers.forEach(([id, handlers], entry) => {
      const [expectedId, originals] = expected.handlers[entry];
      check(id === expectedId, "handler identity");
      list(handlers, originals.length, originals.length);
      handlers.forEach((handler, position) => {
        shape(handler, "data limit hitLimit params");
        check(handler.limit === originals[position].limit, "string limit mismatch");
        check(
          typeof handler.data === "string" && handler.data.length <= handler.limit,
          "string payload limit",
        );
        check(
          typeof handler.hitLimit === "boolean" && (!handler.hitLimit || handler.data.length === 0),
          "string limit state",
        );
        if (handler.params !== null) validateParameters(handler.params);
        check(
          (handler.params === null) === (originals[position].params === null),
          "handler parameter kind",
        );
      });
    });
    list(saved.active, 128);
    for (const reference of saved.active) {
      list(reference, 2, 2);
      const handlers = saved.handlers.find(([id]) => id === reference[0]);
      check(Boolean(handlers), "active handler identity");
      integer(reference[1], 0, handlers[1].length - 1);
    }
  });
}
