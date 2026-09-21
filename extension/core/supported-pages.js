const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

export function classifyPage(url) {
  if (!url) {
    return {
      supported: false,
      reason: "Clicksheet could not determine which page is active."
    };
  }

  try {
    const page = new URL(url);

    if (SUPPORTED_PROTOCOLS.has(page.protocol)) {
      return { supported: true, reason: "" };
    }
  } catch {
    // Treat malformed or unavailable tab URLs as unsupported.
  }

  return {
    supported: false,
    reason: "Clicksheet is available on standard http(s) web pages only."
  };
}

export function isSupportedPage(url) {
  return classifyPage(url).supported;
}
