import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";

export interface HttpOptions {
  /** SHA-256 fingerprint of the one certificate the server must present (colons optional). Overrides verifyTls. */
  fingerprint?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  verifyTls?: boolean;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  statusText: string;
  body: string;
  /** response headers (lower-case names), for the few devices that hand out a session cookie */
  headers: Record<string, string | string[] | undefined>;
}

export class HttpError extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(message);
  }
}

export const normalizeFingerprint = (fp: string) => fp.replace(/[^0-9a-fA-F]/g, "").toUpperCase();

/** TLS options for node:https: either normal verification, no verification, or exact-certificate pinning. */
export function tlsOptions(opts: { verifyTls?: boolean; fingerprint?: string }) {
  if (opts.fingerprint) {
    const want = normalizeFingerprint(opts.fingerprint);
    return {
      rejectUnauthorized: false,
      checkServerIdentity: (_host: string, cert: { fingerprint256?: string }) =>
        normalizeFingerprint(cert.fingerprint256 ?? "") === want ? undefined : new Error("TLS certificate does not match the pinned fingerprint"),
    };
  }
  return { rejectUnauthorized: opts.verifyTls ?? true };
}

export function basicAuth(user: string, pass: string) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

export function httpRequestRaw(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload =
      opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
    if (payload !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(payload));
      if (typeof opts.body !== "string") headers["content-type"] ??= "application/json";
    }
    const base = { method: opts.method ?? "GET", headers, timeout: opts.timeoutMs ?? 8000 };
    const onResponse = (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
          headers: res.headers,
        }),
      );
    };
    const req =
      u.protocol === "https:"
        ? httpsRequest(u, { ...base, ...tlsOptions(opts) }, onResponse)
        : httpRequest(u, base, onResponse);
    req.on("timeout", () => req.destroy(new Error(`${base.method} ${u.host}${u.pathname} timed out`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export async function httpText(url: string, opts: HttpOptions = {}): Promise<string> {
  const res = await httpRequestRaw(url, opts);
  if (res.status >= 400) {
    const u = new URL(url);
    throw new HttpError(res.status, res.body, `${opts.method ?? "GET"} ${u.pathname} -> ${res.status} ${res.statusText}`.trim());
  }
  return res.body;
}

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  return JSON.parse(await httpText(url, opts)) as T;
}
