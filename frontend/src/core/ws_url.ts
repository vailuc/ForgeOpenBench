/**
 * ws_url.ts — Dynamic WebSocket URL builder.
 *
 * Resolves ws:// or wss:// based on page protocol and host, with an optional
 * port override for services that run on a different port than the frontend.
 *
 * In dev (Vite on :5173), pass the explicit service port.
 * In production (all services behind a reverse proxy on the same origin),
 * omit the port and the host is used as-is.
 */
export function wsUrl(path: string, port?: number): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const hostname = window.location.hostname;
  const p = port ? `:${port}` : "";
  return `${proto}://${hostname}${p}${path}`;
}
