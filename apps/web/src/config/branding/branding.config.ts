import { APP_BASE_NAME, APP_SERVER_NAME, APP_SERVER_SLUG } from "@bigbud/contracts";

export { APP_BASE_NAME, APP_SERVER_NAME, APP_SERVER_SLUG };
export const APP_STAGE_LABEL = import.meta.env.DEV ? "Dev" : "Alpha";
export const APP_DISPLAY_NAME = `${APP_BASE_NAME} (${APP_STAGE_LABEL})`;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
