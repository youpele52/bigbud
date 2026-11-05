// Trusted synthetic-state experiment only. This is NOT a hostile wire decoder.
export const fields = (object, names) =>
  Object.fromEntries(names.split(" ").map((name) => [name, object[name]]));
export const copy = (value) => structuredClone(value);

export function attribute(value) {
  return { fg: value.fg, bg: value.bg, extended: fields(value.extended, "_ext _urlId") };
}

export function restoreAttribute(template, value) {
  const result = template.clone();
  result.fg = value.fg;
  result.bg = value.bg;
  Object.assign(result.extended, value.extended);
  return result;
}

const paramFields =
  "maxLength maxSubParamsLength length _subParamsLength _rejectDigits _rejectSubDigits _digitIsSub";
export function parameters(value) {
  return {
    ...fields(value, paramFields),
    params: Array.from(value.params),
    _subParams: Array.from(value._subParams),
    _subParamsIdx: Array.from(value._subParamsIdx),
  };
}

export function restoreParameters(template, value) {
  const result = new template.constructor(value.maxLength, value.maxSubParamsLength);
  Object.assign(result, fields(value, paramFields));
  for (const name of ["params", "_subParams", "_subParamsIdx"]) result[name].set(value[name]);
  return result;
}

export function lineState(line) {
  return {
    data: Array.from(line._data),
    combined: copy(line._combined),
    extended: Object.fromEntries(
      Object.entries(line._extendedAttrs).map(([key, value]) => [
        key,
        fields(value, "_ext _urlId"),
      ]),
    ),
    length: line.length,
    wrapped: line.isWrapped,
  };
}

export function restoreLine(buffer, value, Line) {
  // getBlankLine mutates the target's cached null cell; use the trusted local class directly.
  const line = new Line(value.length);
  line._data = Uint32Array.from(value.data);
  line._combined = copy(value.combined);
  line._extendedAttrs = Object.fromEntries(
    Object.entries(value.extended).map(([key, attr]) => {
      const extended = buffer.savedCurAttrData.extended.clone();
      Object.assign(extended, attr);
      return [key, extended];
    }),
  );
  line.length = value.length;
  line.isWrapped = value.wrapped;
  return line;
}
