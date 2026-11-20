/**
 * What counts as "launchable" for system open: anything the OS default handler would run,
 * install or mount instead of display. Launchable paths are revealed in the file manager,
 * never opened (system-wide search plan §7, no confirm-to-launch override).
 */

/** File extensions (lower case, with the dot) that run, install or mount when opened. */
const LAUNCHABLE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // macOS
  ".app",
  ".command",
  ".tool",
  ".terminal",
  ".workflow",
  ".action",
  ".scpt",
  ".scptd",
  ".applescript",
  ".pkg",
  ".mpkg",
  ".dmg",
  ".mobileconfig",
  ".webloc",
  ".inetloc",
  ".fileloc",
  ".prefpane",
  ".kext",
  ".saver",
  // Windows
  ".exe",
  ".com",
  ".scr",
  ".pif",
  ".bat",
  ".cmd",
  ".ps1",
  ".psm1",
  ".psd1",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".hta",
  ".msi",
  ".msp",
  ".msix",
  ".msixbundle",
  ".appx",
  ".appxbundle",
  ".appinstaller",
  ".application",
  ".appref-ms",
  ".cpl",
  ".msc",
  ".reg",
  ".inf",
  ".lnk",
  ".url",
  ".scf",
  ".gadget",
  ".settingcontent-ms",
  // Linux
  ".desktop",
  ".appimage",
  ".run",
  ".deb",
  ".rpm",
  ".snap",
  ".flatpak",
  ".flatpakref",
  // Cross-platform scripts and packaged programs
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".csh",
  ".ksh",
  ".py",
  ".pyw",
  ".pyz",
  ".rb",
  ".pl",
  ".jar",
  ".jnlp",
  ".apk",
  ".xpi",
]);

/** Directory extensions that are bundles the OS launches or installs (macOS packages). */
const LAUNCHABLE_DIRECTORY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".app",
  ".pkg",
  ".mpkg",
  ".prefpane",
  ".kext",
  ".saver",
  ".appex",
  ".xpc",
  ".plugin",
  ".bundle",
  ".framework",
  ".systemextension",
  ".qlgenerator",
  ".mdimporter",
  ".workflow",
  ".action",
  ".scptd",
  ".wdgt",
]);

/** Lower-cased extension of the last path component (`""` when there is none). */
export function lastPathExtension(path: string): string {
  const name =
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

export function hasLaunchableFileExtension(path: string): boolean {
  return LAUNCHABLE_FILE_EXTENSIONS.has(lastPathExtension(path));
}

export function hasLaunchableDirectoryExtension(path: string): boolean {
  return LAUNCHABLE_DIRECTORY_EXTENSIONS.has(lastPathExtension(path));
}

/** Number of leading bytes {@link hasExecutableMagic} needs. */
export const EXECUTABLE_MAGIC_BYTES = 4;

/** ELF, Mach-O (thin and fat, both byte orders), PE/COFF (`MZ`) or a `#!` script. */
export function hasExecutableMagic(header: Uint8Array): boolean {
  const [b0, b1, b2, b3] = header;
  if (b0 === 0x23 && b1 === 0x21) return true; // "#!"
  if (b0 === 0x4d && b1 === 0x5a) return true; // "MZ"
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return false;
  const word = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  return (
    word === 0x7f454c46 || // ELF
    word === 0xfeedface ||
    word === 0xfeedfacf ||
    word === 0xcefaedfe ||
    word === 0xcffaedfe ||
    word === 0xcafebabe || // Mach-O universal (also Java class files)
    word === 0xbebafeca
  );
}
