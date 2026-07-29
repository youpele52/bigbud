import { isMacPlatform, isWindowsPlatform } from "../../lib/utils";

export type ComputerUsePlatform = "linux" | "mac" | "other" | "windows";

export function detectComputerUsePlatform(platform: string): ComputerUsePlatform {
  if (isMacPlatform(platform)) {
    return "mac";
  }
  if (isWindowsPlatform(platform)) {
    return "windows";
  }
  if (/linux/i.test(platform)) {
    return "linux";
  }
  return "other";
}

export function isMacComputerUsePlatform(platform: string): boolean {
  return detectComputerUsePlatform(platform) === "mac";
}

export function getComputerUseSettingsDescription(platform: string): string {
  if (isMacComputerUsePlatform(platform)) {
    return "Allow agents to control native macOS apps such as Calendar and Reminders, capture screens, and interact through accessibility.";
  }
  return "Allow agents to control native desktop apps, capture screens, and interact through accessibility features when supported.";
}

export function getComputerUseLimitedCapabilityDescription(platform: string): string {
  if (isMacComputerUsePlatform(platform)) {
    return "With desktop automation disabled, agents cannot open or read native apps like Calendar or Reminders. Browser automation inside bigbud may still work.";
  }
  return "With desktop automation disabled, agents cannot open or read native desktop apps. Browser automation inside bigbud may still work.";
}

export function getComputerUsePermissionsTitle(platform: string): string {
  return isMacComputerUsePlatform(platform) ? "macOS permissions" : "Desktop permissions";
}

export function getComputerUsePermissionsDescription(platform: string): string {
  if (isMacComputerUsePlatform(platform)) {
    return "Desktop automation requires Accessibility and Screen Recording access. Grant them in System Settings, then check access here.";
  }
  return "Desktop automation may require additional operating system permissions depending on your platform. Grant them in your system settings, then check access here.";
}

export function getComputerUsePermissionsToastTitle(platform: string): string {
  return isMacComputerUsePlatform(platform)
    ? "Finish macOS permissions"
    : "Finish desktop permissions";
}

export function getComputerUsePermissionsToastDescription(platform: string): string {
  if (isMacComputerUsePlatform(platform)) {
    return "Open System Settings to grant Accessibility and Screen Recording, then return to bigbud and check access.";
  }
  return "Grant the needed operating system permissions in system settings, then return to bigbud and check access.";
}

export function getComputerUsePermissionsRequestFallback(platform: string): string {
  if (isMacComputerUsePlatform(platform)) {
    return "macOS may still require approval in System Settings for Accessibility and Screen Recording.";
  }
  return "Your operating system may still require additional approval to finish enabling desktop automation.";
}
