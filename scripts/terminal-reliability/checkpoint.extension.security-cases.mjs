// Standalone for both Node and the isolated browser realm. Uses only arguments
// and native globals, never the codec's schema/projection as its refusal oracle.
export function custodyRefusalChecks(Terminal, referenceState) {
  const source = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
  const target = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
  const snapshot = source.exportExperimentalCheckpoint();
  const before = JSON.stringify(referenceState(target));
  const accounting = JSON.stringify(target.experimentalCheckpointAccounting());
  let callbacks = 0,
    cases = 0;
  const reject = (pages) => {
    let refused = false;
    try {
      target.importExperimentalCheckpoint({ ...snapshot, pages });
    } catch {
      refused = true;
    }
    if (
      !refused ||
      callbacks !== 0 ||
      before !== JSON.stringify(referenceState(target)) ||
      accounting !== JSON.stringify(target.experimentalCheckpointAccounting())
    )
      throw new Error("page custody refusal invoked caller code or changed target/reservations");
    cases++;
  };
  const clone = () => snapshot.pages.map((page) => page.slice());
  try {
    if (typeof SharedArrayBuffer !== "function")
      throw new Error("SAB refusal test requires isolated realm support");
    const pages = clone();
    const shared = new Uint8Array(new SharedArrayBuffer(pages[0].length));
    shared.set(pages[0]);
    // Genuine SAB view falsely claiming an ordinary backing store: old code
    // would accept the exact payload and borrow concurrently writable memory.
    Object.defineProperty(shared, "buffer", { value: new ArrayBuffer(shared.length) });
    pages[0] = shared;
    reject(pages);
    const sharedGetters = clone();
    const hiddenShared = new Uint8Array(new SharedArrayBuffer(sharedGetters[0].length));
    hiddenShared.set(sharedGetters[0]);
    for (const key of ["buffer", "byteLength", "byteOffset", "length"])
      Object.defineProperty(hiddenShared, key, {
        get() {
          callbacks++;
          throw new Error("must never invoke shadowed SAB getter");
        },
      });
    sharedGetters[0] = hiddenShared;
    reject(sharedGetters);
    for (const key of [
      "buffer",
      "byteLength",
      "byteOffset",
      "length",
      Symbol.iterator,
      Symbol.toStringTag,
    ]) {
      const altered = clone();
      Object.defineProperty(altered[0], key, {
        get() {
          callbacks++;
          throw new Error("must never invoke page getter");
        },
      });
      reject(altered);
    }
    const proxy = clone();
    proxy[0] = new Proxy(proxy[0], {
      get() {
        callbacks++;
        throw new Error("must never invoke page Proxy get");
      },
      getPrototypeOf() {
        callbacks++;
        throw new Error("must never invoke page Proxy prototype trap");
      },
      getOwnPropertyDescriptor() {
        callbacks++;
        throw new Error("must never invoke page Proxy descriptor trap");
      },
    });
    reject(proxy);
    const iterator = clone();
    Object.defineProperty(iterator, Symbol.iterator, {
      get() {
        callbacks++;
        throw new Error("must never invoke page-list iterator");
      },
    });
    reject(iterator);
    const prototype = clone();
    Object.setPrototypeOf(prototype[0], Object.create(Uint8Array.prototype));
    reject(prototype);
    const detached = clone();
    structuredClone(detached[0].buffer, { transfer: [detached[0].buffer] });
    reject(detached);
    if (Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")) {
      const resizable = clone();
      const backing = new ArrayBuffer(resizable[0].length, {
        maxByteLength: resizable[0].length + 32,
      });
      const view = new Uint8Array(backing);
      view.set(resizable[0]);
      resizable[0] = view;
      reject(resizable);
    }
    const wasm = new WebAssembly.Memory({ initial: 1 });
    const stale = clone();
    stale[0] = new Uint8Array(wasm.buffer, 0, stale[0].length);
    wasm.grow(1);
    reject(stale);
    return { cases, callbacks, unchangedStateAndReservations: true };
  } finally {
    source.releaseExperimentalCheckpoint(snapshot);
    source.dispose();
    target.dispose();
  }
}

export function themeRefusalChecks(Terminal, referenceState) {
  const source = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
  const snapshot = source.exportExperimentalCheckpoint();
  let cases = 0;
  try {
    for (const operation of [
      (terminal) => {
        terminal.options.theme = { red: "#123456" };
      },
      (terminal) => {
        terminal.options = { theme: { foreground: "#abcdef" } };
      },
      (terminal) => {
        terminal.options.theme = { red: "#123456" };
        terminal.options.theme = {};
      },
      (terminal) => {
        terminal.options.theme.red = "#123456";
      },
    ]) {
      const target = new Terminal({ cols: 20, rows: 6, theme: {}, allowProposedApi: true });
      try {
        operation(target);
        const before = JSON.stringify(referenceState(target));
        const accounting = JSON.stringify(target.experimentalCheckpointAccounting());
        for (const action of [
          () => target.exportExperimentalCheckpoint(),
          () => target.importExperimentalCheckpoint(snapshot),
        ]) {
          let reason;
          try {
            action();
          } catch (error) {
            reason = String(error);
          }
          if (
            !reason?.includes("palette/query") ||
            before !== JSON.stringify(referenceState(target)) ||
            accounting !== JSON.stringify(target.experimentalCheckpointAccounting())
          )
            throw new Error(
              "changed-theme checkpoint did not refuse without mutation/reservation changes",
            );
          cases++;
        }
      } finally {
        target.dispose();
      }
    }
    const initial = new Terminal({ theme: { red: "#123456" }, allowProposedApi: true });
    try {
      let refused = false;
      try {
        initial.exportExperimentalCheckpoint();
      } catch (error) {
        refused = String(error).includes("palette/query");
      }
      if (!refused) throw new Error("constructor theme must refuse");
      cases++;
    } finally {
      initial.dispose();
    }
    return { cases, unchangedStateAndReservations: true };
  } finally {
    source.releaseExperimentalCheckpoint(snapshot);
    source.dispose();
  }
}
