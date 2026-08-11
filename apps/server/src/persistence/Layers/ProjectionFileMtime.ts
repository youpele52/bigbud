import { Option } from "effect";

const UNIX_EPOCH = new Date(0);

export function resolveFileMtime(mtime: Date | Option.Option<Date>): Date {
  const value = Option.isOption(mtime) ? Option.getOrElse(mtime, () => UNIX_EPOCH) : mtime;
  return Number.isFinite(value.getTime()) ? value : UNIX_EPOCH;
}
