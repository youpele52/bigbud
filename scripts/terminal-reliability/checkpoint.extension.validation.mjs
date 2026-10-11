import { isTyped, isString, TypedSlice } from "./checkpoint.extension.pages.mjs";
// Cross-field defense for schema 2; production/exact capability remains closed.
function keys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(expected.toSorted())
  ) {
    throw new Error("unexpected projection fields");
  }
}
function sameKeys(value, template) {
  keys(value, Object.keys(template));
  const prototype = Object.getPrototypeOf(template);
  if (
    prototype !== null &&
    prototype !== Object.prototype &&
    Object.getPrototypeOf(value) !== prototype
  )
    throw new Error("invalid projection prototype");
}
function attrs(value, template) {
  sameKeys(value, template);
  sameKeys(value.extended, template.extended);
  if (
    ![value.fg, value.bg, value.extended._ext, value.extended._urlId].every(Number.isInteger) ||
    value.extended._urlId !== 0 ||
    ((value.extended._ext >>> 26) & 7) > 5
  )
    throw new Error("invalid attribute/link state");
}
function params(value, template) {
  sameKeys(value, template);
  if (
    value.maxLength !== template.maxLength ||
    value.maxSubParamsLength !== template.maxSubParamsLength ||
    !isTyped(value.params, Int32Array) ||
    !isTyped(value._subParams, Int32Array) ||
    !isTyped(value._subParamsIdx, Uint16Array) ||
    value.params.length !== value.maxLength ||
    value._subParams.length !== value.maxSubParamsLength ||
    value._subParamsIdx.length !== value.maxLength ||
    !Number.isInteger(value.length) ||
    value.length < 0 ||
    value.length > value.maxLength ||
    !Number.isInteger(value._subParamsLength) ||
    value._subParamsLength < 0 ||
    value._subParamsLength > value.maxSubParamsLength
  )
    throw new Error("invalid parameter references");
  if (value.params.some((item) => item < -1) || value._subParams.some((item) => item < -1))
    throw new Error("invalid parameter values");
  for (const [position, index] of value._subParamsIdx.entries()) {
    const limit = position < value.length ? value._subParamsLength : value.maxSubParamsLength;
    if (index >>> 8 > (index & 255) || (index & 255) > limit)
      throw new Error("invalid subparameter reference");
  }
}
function control(value, template, parameterTemplate, payloadActive) {
  sameKeys(value, template);
  sameKeys(value.fields, template.fields);
  sameKeys(value.fields._stack, template.fields._stack);
  if (
    value.fields._stack.paused ||
    !Array.isArray(value.handlers) ||
    !Array.isArray(value.active) ||
    value.handlers.length !== template.handlers.length
  )
    throw new Error("unsupported handler state");
  const known = new Map(template.handlers);
  const seen = new Set();
  for (const [id, list] of value.handlers) {
    if (
      seen.has(id) ||
      !known.has(id) ||
      !Array.isArray(list) ||
      list.length !== known.get(id).length
    )
      throw new Error("invalid handler references");
    seen.add(id);
    for (const item of list) {
      sameKeys(item, known.get(id)[0]);
      if (!isString(item._data) || typeof item._hitLimit !== "boolean")
        throw new Error("invalid handler data");
      if (item._params !== undefined) params(item._params, parameterTemplate);
    }
  }
  const active = new Set();
  for (const [id, index] of value.active) {
    const key = `${id}/${index}`;
    if (
      !known.has(id) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= known.get(id).length ||
      active.has(key) ||
      Number(id) !== (value.fields._id ?? value.fields._ident)
    )
      throw new Error("invalid active handler reference");
    active.add(key);
  }
  const id = String(value.fields._id ?? value.fields._ident);
  const expected = payloadActive ? (known.get(id) ?? []).map((_, index) => [id, index]) : [];
  if (JSON.stringify(value.active) !== JSON.stringify(expected))
    throw new Error("incomplete active handler references");
}

export function validateProjection(state, template) {
  // Exact allowlists precede every fixed-field restore in applyState, including objects
  // with sampled prototypes. No import can replace _parser/services/methods.
  sameKeys(state, template);
  sameKeys(state.bufferService, template.bufferService);
  sameKeys(state.handler, template.handler);
  sameKeys(state.parser, template.parser);
  sameKeys(state.charset, template.charset);
  sameKeys(state.modes, template.modes);
  sameKeys(state.modes.modes, template.modes.modes);
  sameKeys(state.modes.decPrivateModes, template.modes.decPrivateModes);
  sameKeys(state.mouse, template.mouse);
  if (!Object.values(state.modes.modes).every((value) => typeof value === "boolean"))
    throw new Error("invalid modes");
  for (const [key, value] of Object.entries(state.modes.decPrivateModes)) {
    const valid =
      key === "cursorStyle"
        ? [undefined, "block", "underline", "bar"].includes(value)
        : key === "cursorBlink"
          ? value === undefined || typeof value === "boolean"
          : typeof value === "boolean";
    if (!valid) throw new Error("invalid modes");
  }
  attrs(state.handler._curAttrData, template.handler._curAttrData);
  attrs(state.handler._eraseAttrDataInternal, template.handler._eraseAttrDataInternal);
  params(state.parser._params, template.parser._params);
  control(state.osc, template.osc, template.parser._params, state.osc.fields._state === 2);
  control(state.dcs, template.dcs, template.parser._params, state.parser.currentState === 13);
  if (
    state.osc.fields._state !== 0 &&
    [4, 10, 11, 12, 104, 110, 111, 112].includes(state.osc.fields._id)
  )
    throw new Error("unsupported palette/query authority state");
  for (const [index, buffer] of state.buffers.entries()) {
    sameKeys(buffer, template.buffers[index]);
    sameKeys(buffer.fields, template.buffers[index].fields);
    attrs(buffer.fields.savedCurAttrData, template.handler._curAttrData);
    for (const line of buffer.lines) {
      sameKeys(line, template.buffers[0].lines[0]);
      for (const map of [line._combined, line._extendedAttrs]) {
        if (!map || typeof map !== "object" || Array.isArray(map))
          throw new Error("invalid cell map");
        for (const key of Object.keys(map)) {
          if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= line.length)
            throw new Error("invalid cell reference");
        }
      }
      if (!Object.values(line._combined).every(isString)) throw new Error("invalid combined cells");
      for (const value of Object.values(line._extendedAttrs)) {
        sameKeys(value, template.handler._curAttrData.extended);
        if (value._urlId !== 0 || !Number.isInteger(value._ext) || ((value._ext >>> 26) & 7) > 5)
          throw new Error("invalid extended cells");
      }
      const get = (index) =>
        line._data instanceof TypedSlice ? line._data.get(index) : line._data[index];
      for (let column = 0; column < line.length; column++) {
        const content = get(column * 3);
        if (
          ((content >>> 22) & 3) > 2 ||
          (content & 0x200000
            ? !Object.hasOwn(line._combined, column)
            : (content & 0x1fffff) > 0x10ffff) ||
          (get(column * 3 + 2) & 0x10000000 && !Object.hasOwn(line._extendedAttrs, column))
        )
          throw new Error("invalid cell/extended reference");
      }
    }
  }
}
