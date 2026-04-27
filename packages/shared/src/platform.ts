export const NODE_PLATFORM_DARWIN = "darwin";
export const NODE_PLATFORM_LINUX = "linux";
export const NODE_PLATFORM_WIN32 = "win32";

export type NodePlatform =
  | typeof NODE_PLATFORM_DARWIN
  | typeof NODE_PLATFORM_LINUX
  | typeof NODE_PLATFORM_WIN32;
