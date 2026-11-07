/**
 * Argument and output helpers shared by the read-only report scripts
 * (`connection-health-report.ts`, `database-size-report.ts`).
 */

export const argValue = (
  flag: string,
  argv: ReadonlyArray<string> = process.argv,
): string | undefined => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

export const hasFlag = (flag: string, argv: ReadonlyArray<string> = process.argv): boolean =>
  argv.includes(flag);

/** `label  value  suffix` rows: labels padded to the widest, values right-aligned in 8. */
export function formatLabeledRows(
  rows: ReadonlyArray<
    readonly [label: string, value: string | number, suffix?: string | undefined]
  >,
): Array<string> {
  const width = Math.max(0, ...rows.map(([label]) => label.length));
  return rows.map(([label, value, suffix]) =>
    `${label.padEnd(width)}  ${String(value).padStart(8)}${suffix ? `   ${suffix}` : ""}`.trimEnd(),
  );
}

/** A plain-text table: first column left-aligned, the rest right-aligned. */
export function formatTable(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): Array<string> {
  const cells = [header, ...rows].map((row) => row.map(String));
  const widths = header.map((_, column) =>
    Math.max(...cells.map((row) => (row[column] ?? "").length)),
  );
  return cells.map((row) =>
    row
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!),
      )
      .join("  ")
      .trimEnd(),
  );
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Binary units with one decimal above bytes, e.g. `8.2 GB`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

export const formatCount = (count: number): string => count.toLocaleString("en-US");
