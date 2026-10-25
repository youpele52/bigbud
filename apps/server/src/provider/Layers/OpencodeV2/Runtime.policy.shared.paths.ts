/** Native Windows wildcard matching folds slashes/case but does not remove the long-path prefix. */
export function v2SharedProtectedResources(
  roots: readonly string[],
  windows = process.platform === "win32",
): string[] {
  const names = roots.flatMap((root) => {
    if (!windows) return [root];
    const normal = root.replaceAll("/", "\\").replace(/^\\\\\?\\(?=[a-z]:\\)/i, "");
    return /^[a-z]:\\/i.test(normal) ? [normal, `\\\\?\\${normal}`] : [normal];
  });
  return [...new Set(names)].flatMap((root) => [root, `${root}/*`]);
}
