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

export function getComputerUseDialogDescription(): string {
  return "bigbud can automate native desktop apps and the in-app browser so agents can help with tasks like navigating desktop software, capturing screens, and interacting across apps.";
}

export function getComputerUsePermissionPromptDescription(platform: string): string {
  if (isMacComputerUsePlatform(platform)) {
    return "Requires Accessibility and Screen Recording. macOS will prompt you after you continue.";
  }
  return "Desktop automation may require additional operating system permissions. bigbud will request access when your platform supports it.";
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
    return "Desktop automation requires Accessibility and Screen Recording access. macOS will prompt when permissions are first requested.";
  }
  return "Desktop automation may require additional operating system permissions depending on your platform. bigbud will request access when needed.";
}

export function getComputerUsePermissionsToastTitle(platform: string): string {
  return isMacComputerUsePlatform(platform)
    ? "Finish macOS permissions"
    : "Finish desktop permissions";
}

export function getComputerUsePermissionsToastDescription(platform: string): string {
  if (isMacComputerUsePlatform(platform)) {
    return "Approve Accessibility and Screen Recording to finish enabling Computer Use.";
  }
  return "Approve any operating system permission prompts to finish enabling Computer Use.";
}

export function getComputerUsePermissionsRequestFallback(platform: string): string {
  if (isMacComputerUsePlatform(platform)) {
    return "macOS may still require approval in System Settings for Accessibility and Screen Recording.";
  }
  return "Your operating system may still require additional approval to finish enabling desktop automation.";
}
