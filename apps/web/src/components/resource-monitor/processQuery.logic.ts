import type { MonitorProcessQuery } from "@bigbud/contracts/system-monitor/types";

import type { ProcessQueryControls } from "./ProcessTable";

function boundedUtf8(value: string): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  for (const character of value.trim()) {
    const width = encoder.encode(character).length;
    if (bytes + width > 256) break;
    result += character;
    bytes += width;
  }
  return result;
}

export function buildProcessQuery(
  controls: ProcessQueryControls,
  cursor?: MonitorProcessQuery["cursor"],
): MonitorProcessQuery {
  const search = boundedUtf8(controls.search);
  const pid = /^\d+$/.test(search) ? Number(search) : NaN;
  const isPid = Number.isSafeInteger(pid) && pid <= 0xffffffff;
  return {
    ...(isPid ? { pid } : { name: search }),
    status: boundedUtf8(controls.status),
    sort: controls.sort,
    descending: controls.descending,
    limit: 100,
    ...(cursor ? { cursor } : {}),
  };
}
