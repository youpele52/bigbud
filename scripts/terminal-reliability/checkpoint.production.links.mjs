// Rebuild marker subscriptions against the TARGET buffers, never copy source callbacks.
export function captureLinks(core) {
  const buffers = [core.buffers.normal, core.buffers.alt];
  const owned = new Set();
  const entries = Array.from(core._oscLinkService._dataByLinkId, ([id, entry]) => ({
    id,
    data: { ...entry.data },
    markers: entry.lines.map((marker) => {
      const buffer = buffers.findIndex((item) => item.markers.includes(marker));
      if (buffer < 0 || marker.isDisposed) throw new Error("unowned hyperlink marker");
      owned.add(marker);
      return { buffer, line: marker.line };
    }),
  }));
  if (buffers.some((buffer) => buffer.markers.some((marker) => !owned.has(marker))))
    throw new Error("external markers are not qualified");
  return { nextId: core._oscLinkService._nextId, entries };
}

export function prepareLinks(core, state, preparedLines) {
  const service = core._oscLinkService;
  const buffers = [core.buffers.normal, core.buffers.alt];
  const owners = buffers.map((buffer, index) => {
    const owner = Object.create(buffer);
    owner.lines = preparedLines[index];
    owner.markers = [];
    Object.defineProperty(owner, "_isClearing", { get: () => buffer._isClearing });
    return owner;
  });
  const byId = new Map(),
    withId = new Map();
  for (const saved of state.entries) {
    const entry = { id: saved.id, data: { ...saved.data }, lines: [] };
    if (saved.data.id !== undefined) {
      entry.key = `${saved.data.id};;${saved.data.uri}`;
      withId.set(entry.key, entry);
    }
    byId.set(entry.id, entry);
    for (const position of saved.markers) {
      const marker = owners[position.buffer].addMarker(position.line);
      entry.lines.push(marker);
      marker.onDispose(() => service._removeMarkerFromLink(entry, marker));
    }
  }
  return () => {
    service._nextId = state.nextId;
    service._dataByLinkId = byId;
    service._entriesWithId = withId;
    buffers.forEach((buffer, index) => {
      buffer.markers = owners[index].markers;
    });
  };
}
