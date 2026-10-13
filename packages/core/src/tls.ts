import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";

export interface TlsMaterial {
  key: Buffer;
  cert: Buffer;
  generated: boolean;
  names: string[];
}

function localNames(configured: string[]): string[] {
  const extra = [...configured, ...(process.env.LUMINA_TLS_NAMES ?? "").split(",")].map((s) => s.trim()).filter(Boolean);
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((n): n is NonNullable<typeof n> => !!n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);
  return [...new Set([hostname(), "localhost", "127.0.0.1", ...ips, ...extra])];
}

const isIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":");

/**
 * HTTPS is on when a certificate is supplied (LUMINA_TLS_CERT + LUMINA_TLS_KEY) or LUMINA_TLS=auto,
 * which creates and renews a self-signed certificate covering this machine's hostname and IP addresses.
 */
export function loadTls(cfg: ServerConfig, dataDir: string, log: { info: (o: object, m: string) => void }): TlsMaterial | null {
  const certEnv = process.env.LUMINA_TLS_CERT;
  const keyEnv = process.env.LUMINA_TLS_KEY;
  if (certEnv && keyEnv) return { cert: readFileSync(certEnv), key: readFileSync(keyEnv), generated: false, names: [] };
  if (cfg.tls === "off") return null;

  const dir = join(dataDir, "tls");
  if (cfg.tls === "custom") {
    const c = join(dir, "custom.crt");
    const k = join(dir, "custom.key");
    if (!existsSync(c) || !existsSync(k)) throw new Error("HTTPS is set to 'custom certificate' but no certificate has been uploaded");
    return { cert: readFileSync(c), key: readFileSync(k), generated: false, names: [] };
  }

  const cert = join(dir, "lumina.crt");
  const key = join(dir, "lumina.key");
  const namesFile = join(dir, "lumina.names");
  const names = localNames(cfg.names);

  let fresh = false;
  if (existsSync(cert) && existsSync(key) && existsSync(namesFile)) {
    try {
      execFileSync("openssl", ["x509", "-checkend", String(30 * 86400), "-noout", "-in", cert], { stdio: "ignore" });
      fresh = readFileSync(namesFile, "utf8") === names.join(",");
    } catch {
      fresh = false;
    }
  }

  if (!fresh) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const san = names.map((n) => (isIp(n) ? `IP:${n}` : `DNS:${n}`)).join(",");
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "825", "-sha256",
        "-subj", `/CN=${hostname()}/O=Lumina`,
        "-addext", `subjectAltName=${san}`,
        "-addext", "basicConstraints=critical,CA:FALSE",
        "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
        "-addext", "extendedKeyUsage=serverAuth",
      ],
      { stdio: "ignore" },
    );
    chmodSync(key, 0o600);
    writeFileSync(namesFile, names.join(","));
    log.info({ names }, "generated self-signed TLS certificate");
  }
  return { cert: readFileSync(cert), key: readFileSync(key), generated: true, names };
}

/** Plain-HTTP listener whose only job is to send browsers to the HTTPS site. */
export function startHttpRedirect(port: number, httpsPort: number, log: { warn: (o: object, m: string) => void }): Server {
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!/^[A-Za-z0-9.\-[\]:]+$/.test(host)) {
      res.writeHead(400).end("Bad request");
      return;
    }
    const target = `https://${host}${httpsPort === 443 ? "" : `:${httpsPort}`}${(req.url ?? "/").startsWith("/") ? req.url : "/"}`;
    res.writeHead(308, { Location: target }).end();
  });
  server.on("error", (err) => log.warn({ err, port }, "HTTP redirect listener failed"));
  server.listen(port, "0.0.0.0");
  return server;
}
