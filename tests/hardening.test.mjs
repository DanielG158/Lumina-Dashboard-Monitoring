// A malformed Origin must not take the server down, and two simultaneous first-run setups must not both create an admin.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(300); } return false; };

const port = 3983;
const dir = mkdtempSync(join(tmpdir(), "lumina-hard-"));
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(port), LUMINA_DATA: dir, LUMINA_TLS: "off", LOG_LEVEL: "error" }, stdio: "ignore" });
let exited = false; child.on("exit", () => { exited = true; });
const base = `http://127.0.0.1:${port}`;
await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 20000);

const rawGet = (path, origin) => new Promise((resolve) => {
  const req = http.get({ host: "127.0.0.1", port, path, headers: { origin } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
  req.on("error", () => resolve(0));
});
const code = await rawGet("/socket.io/?EIO=4&transport=polling", ":");
await sleep(500);
check("a malformed Origin is refused instead of crashing the server", !exited && code === 403, `status ${code}, exited ${exited}`);
check("the server still answers afterwards", (await fetch(`${base}/health`).catch(() => ({ ok: false }))).ok);

const setupCode = readFileSync(join(dir, "setup-code"), "utf8").trim();
const setup = (name) => fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name, password: "correct horse battery", setupCode }) }).then((r) => r.status);
const codes = await Promise.all([setup("first"), setup("second"), setup("third")]);
check("only one of several simultaneous setups succeeds", codes.filter((c) => c === 200 || c === 201).length === 1, codes.join(","));
child.kill();
process.exit(ok ? 0 : 1);
