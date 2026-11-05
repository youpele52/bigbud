/** A deadline cannot cancel a kernel filesystem call. Keep at most one preflight outstanding. */
export function makeBoundedShellFileCheck(check: (path: string) => Promise<boolean>) {
  let pending: { path: string; result: Promise<boolean> } | undefined;
  return (path: string): Promise<boolean> => {
    if (pending) return pending.path === path ? pending.result : Promise.resolve(true);
    const result = Promise.resolve().then(() => check(path));
    const current = { path, result };
    pending = current;
    void result
      .finally(() => {
        if (pending === current) pending = undefined;
      })
      .catch(() => undefined);
    return result;
  };
}
