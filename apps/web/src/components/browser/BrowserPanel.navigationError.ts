export interface BrowserLoadFailure {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
}

export interface BrowserNavigationErrorContent {
  title: string;
  description: string;
  suggestions: string[];
  technicalCode: string;
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname || "This site";
  } catch {
    return "This site";
  }
}

function getErrorCode(failure: BrowserLoadFailure): string {
  return /^ERR_[A-Z0-9_]+$/.test(failure.errorDescription)
    ? failure.errorDescription
    : "UNKNOWN_NAVIGATION_ERROR";
}

export function classifyBrowserNavigationError(
  failure: BrowserLoadFailure,
): BrowserNavigationErrorContent {
  const hostname = getHostname(failure.validatedURL);
  const technicalCode = getErrorCode(failure);
  const code = failure.errorDescription;

  if (code === "ERR_NAME_NOT_RESOLVED") {
    return {
      title: "This site can't be reached",
      description: `${hostname}'s server IP address could not be found.`,
      suggestions: [
        "Checking the address",
        "Checking the connection, proxy, firewall, and DNS configuration",
      ],
      technicalCode,
    };
  }

  if (code === "ERR_INTERNET_DISCONNECTED") {
    return {
      title: "You're offline",
      description: "This page can't be loaded without an internet connection.",
      suggestions: ["Checking your network connection", "Reconnecting to Wi-Fi or Ethernet"],
      technicalCode,
    };
  }

  if (["ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT"].includes(code)) {
    return {
      title: "This site took too long to respond",
      description: `${hostname} didn't respond in time.`,
      suggestions: ["Checking the connection", "Checking the proxy and firewall"],
      technicalCode,
    };
  }

  if (
    [
      "ERR_CERT_AUTHORITY_INVALID",
      "ERR_CERT_COMMON_NAME_INVALID",
      "ERR_CERT_DATE_INVALID",
      "ERR_CERT_INVALID",
      "ERR_CERT_REVOKED",
      "ERR_CERT_UNABLE_TO_CHECK_REVOCATION",
    ].includes(code)
  ) {
    if (code === "ERR_CERT_DATE_INVALID") {
      return {
        title: "This site's certificate isn't valid",
        description: `${hostname}'s certificate has expired or is not yet valid. Your computer's date and time can also cause this error.`,
        suggestions: [
          "Checking your computer's date and time",
          "Contacting the site owner to renew or correct the certificate",
        ],
        technicalCode,
      };
    }
    return {
      title: "Your connection isn't private",
      description: `bigbud couldn't establish a secure connection to ${hostname}.`,
      suggestions: [
        "Checking your computer's date and time",
        "Opening the site in your default browser for more information",
      ],
      technicalCode,
    };
  }

  if (
    [
      "ERR_CONNECTION_CLOSED",
      "ERR_CONNECTION_RESET",
      "ERR_CONNECTION_REFUSED",
      "ERR_CONNECTION_ABORTED",
      "ERR_ADDRESS_UNREACHABLE",
    ].includes(code)
  ) {
    return {
      title: "This site can't be reached",
      description: `${hostname} refused or closed the connection.`,
      suggestions: ["Checking the connection", "Checking the proxy and firewall"],
      technicalCode,
    };
  }

  return {
    title: "This page couldn't be loaded",
    description: `bigbud couldn't load ${hostname}.`,
    suggestions: ["Checking the address and connection", "Trying again in a moment"],
    technicalCode,
  };
}

export const iframeNavigationError: BrowserNavigationErrorContent = {
  title: "This site couldn't be displayed here",
  description: "The site may not support being opened inside bigbud.",
  suggestions: ["Reloading the page", "Opening it in your default browser"],
  technicalCode: "EMBEDDING_ERROR",
};
