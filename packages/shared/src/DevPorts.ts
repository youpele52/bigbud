export const DEFAULT_SERVER_PORT = 3773;
export const DEFAULT_WEB_PORT = 5733;
export const DEFAULT_MOBILE_WEB_PORT = 5740;

export function devPortsForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
  readonly mobileWebPort: number;
} {
  return {
    serverPort: DEFAULT_SERVER_PORT + offset,
    webPort: DEFAULT_WEB_PORT + offset,
    mobileWebPort: DEFAULT_MOBILE_WEB_PORT + offset,
  };
}
