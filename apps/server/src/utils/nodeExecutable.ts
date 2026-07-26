export function resolveNodeExecutable(): string {
  return process.env.BIGBUD_NODE_EXECUTABLE?.trim() || process.execPath;
}
