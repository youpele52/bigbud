import { fields, copy, parameters, restoreParameters } from "./checkpoint.production.values.mjs";

const parserNames = ["_oscParser", "_dcsParser", "_apcParser"];
const handlers = (map) => Object.entries(map).map(([key, list]) => [key, list.length]);

export function parserProfile(core) {
  const parser = core._inputHandler._parser;
  return JSON.stringify({
    unicode: [core.unicodeService._active, Object.keys(core.unicodeService._providers)],
    csi: handlers(parser._csiHandlers),
    esc: handlers(parser._escHandlers),
    execute: Object.keys(parser._executeHandlers),
    strings: parserNames.map((name) => handlers(parser[name]._handlers)),
  });
}

export function settled(core) {
  const handler = core._inputHandler;
  const parser = handler._parser;
  if (
    core._writeBuffer._pendingData ||
    core._writeBuffer._writeBuffer.length ||
    handler._parseStack.paused ||
    parser._parseStack.state ||
    parserNames.some((name) => parser[name]._stack.paused)
  )
    throw new Error("unsettled parser/write queue");
}

function captureString(parser) {
  const handlers = Object.entries(parser._handlers).map(([id, list]) => [
    id,
    list.map((handler) => ({
      data: handler._data.toString(),
      limit: handler._data.limit,
      hitLimit: handler._hitLimit,
      params: handler._params ? parameters(handler._params) : null,
    })),
  ]);
  const active = parser._active.map((handler) => {
    for (const [id, list] of Object.entries(parser._handlers)) {
      const index = list.indexOf(handler);
      if (index !== -1) return [id, index];
    }
    throw new Error("unknown active string handler");
  });
  return { fields: copy(fields(parser, "_state _id _ident _stack")), handlers, active };
}

export function captureParser(core) {
  const handler = core._inputHandler;
  const parser = handler._parser;
  return {
    fields: fields(parser, "initialState currentState precedingJoinState _collect"),
    params: parameters(parser._params),
    stringCarry: handler._stringDecoder._interim,
    utf8Carry: Array.from(handler._utf8Decoder.interim),
    strings: parserNames.map((name) => captureString(parser[name])),
  };
}

export function prepareParser(core, state) {
  const handler = core._inputHandler;
  const parser = handler._parser;
  const params = restoreParameters(parser._params, state.params);
  const strings = parserNames.map((name, i) => {
    const target = parser[name];
    const saved = state.strings[i];
    const items = saved.handlers.flatMap(([id, list]) =>
      list.map((value, index) => {
        const item = target._handlers[id][index];
        if (item._data.limit !== value.limit) throw new Error("string limit mismatch");
        const data = new item._data.constructor(value.limit);
        if (data.append(value.data)) throw new Error("string limit exceeded");
        return {
          item,
          data,
          hitLimit: value.hitLimit,
          params: value.params ? restoreParameters(parser._params, value.params) : null,
        };
      }),
    );
    return {
      target,
      fields: copy(saved.fields),
      items,
      active: saved.active.map(([id, index]) => target._handlers[id][index]),
    };
  });
  return () => {
    Object.assign(parser, state.fields);
    parser._params = params;
    handler._stringDecoder._interim = state.stringCarry;
    handler._utf8Decoder.interim.set(state.utf8Carry);
    for (const saved of strings) {
      Object.assign(saved.target, saved.fields);
      for (const item of saved.items) {
        item.item._data = item.data;
        item.item._hitLimit = item.hitLimit;
        if (item.params) item.item._params = item.params;
      }
      saved.target._active = saved.active;
    }
  };
}
