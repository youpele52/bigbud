function parseVersion(version: string): readonly [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isVersionAtLeast(version: string, minimum: string): boolean {
  const parsed = parseVersion(version);
  const parsedMinimum = parseVersion(minimum);
  if (!parsed || !parsedMinimum) return true;
  for (let index = 0; index < parsed.length; index += 1) {
    const value = parsed[index]!;
    const minimumValue = parsedMinimum[index]!;
    if (value > minimumValue) return true;
    if (value < minimumValue) return false;
  }
  return true;
}
