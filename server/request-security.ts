import type { Request } from "express";

/**
 * Browser write requests must come from the configured public origin. The
 * request Host remains a local-development fallback only; proxy forwarding
 * headers are deliberately not trusted as an authorization input.
 */
export function isBrowserOriginAllowed(req: Request, publicBaseUrl: string): boolean {
  const origin = req.get("origin");
  if (!origin) return true;

  let requestOrigin: URL;
  try {
    requestOrigin = new URL(origin);
  } catch {
    return false;
  }

  if (publicBaseUrl) {
    try {
      return requestOrigin.origin === new URL(publicBaseUrl).origin;
    } catch {
      return false;
    }
  }

  const host = String(req.get("host") ?? "").trim();
  return Boolean(host) && requestOrigin.host === host;
}

export function shouldUseSecureCookie(req: Request, publicBaseUrl: string): boolean {
  if (publicBaseUrl) {
    try {
      return new URL(publicBaseUrl).protocol === "https:";
    } catch {
      return false;
    }
  }
  return req.secure;
}
