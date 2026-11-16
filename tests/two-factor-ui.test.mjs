// The optional two-factor screens: set it up under My account, then sign in with the code.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const { chromium } = createRequire(ROOT + "/")("playwright-core");
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { codeAt, stepNow } = await import(ROOT + "/packages/core/dist/totp.js");

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3980, PW = "correct horse battery";
const dir = mkdtempSync(join(tmpdir(), "lumina-2fa-ui-"));
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(PORT), LUMINA_DATA: dir, LUMINA_TLS: "off", LOG_LEVEL: "error", LUMINA_STARTUP_GRACE_SECONDS: "0", LUMINA_UI_DIR: ROOT + "/packages/ui/dist" }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ } await sleep(300); }
await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "boss", password: PW, setupCode: readFileSync(join(dir, "setup-code"), "utf8").trim() }) });

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 1000 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
async function signIn(code) {
  await page.getByRole("button", { name: "Sign in" }).first().click();
  await page.fill('input[placeholder="Username"]', "boss");
  await page.fill('input[placeholder="Password"]', PW);
  await page.locator("form.dialog button.primary").click();
  if (code === undefined) return;
  await page.waitForSelector('input[aria-label="Authenticator code"]');
  await page.fill('input[aria-label="Authenticator code"]', code);
  await page.locator("form.dialog button.primary").click();
}
await page.goto(`${base}/#/overview`);
await signIn();
await page.waitForSelector("text=boss ·");
check("signing in without two-factor is unchanged", true);

await page.goto(`${base}/#/settings`);
await page.getByRole("button", { name: "My account" }).click();
await page.waitForSelector("text=Two-factor sign-in");
check("My account offers it, switched off", (await page.locator("body").innerText()).includes("Optional."));
await page.locator('form:has-text("Two-factor") input[type=password]').fill(PW);
await page.getByRole("button", { name: "Set up…" }).click();
await page.waitForSelector('img[alt^="QR code"]');
const key = (await page.locator("code").first().innerText()).replace(/\s/g, "");
check("a QR code and the typed key are shown", /^[A-Z2-7]{32}$/.test(key) && (await page.locator('img[alt^="QR code"]').getAttribute("src")).startsWith("data:image/"));
await page.fill('input[autocomplete="one-time-code"]', codeAt(key, stepNow() - 1));
await page.getByRole("button", { name: "Turn on" }).click();
await page.waitForSelector("text=Recovery codes");
const recovery = (await page.locator("pre").innerText()).trim().split("\n");
check("ten recovery codes are shown once", recovery.length === 10 && recovery.every((c) => /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/.test(c)));
await page.getByRole("button", { name: "I have saved them" }).click();
await page.waitForSelector("text=9 recovery codes left, 10 recovery codes left", { timeout: 1500 }).catch(() => undefined);
check("then it shows as on", (await page.locator("body").innerText()).includes("recovery codes left"));

await page.getByRole("button", { name: "Sign out" }).click();
await page.waitForTimeout(800);
await signIn();
await page.waitForSelector('input[aria-label="Authenticator code"]');
check("after the password, the dialog asks for the code instead of signing in", (await page.locator("text=boss ·").count()) === 0);
await page.fill('input[aria-label="Authenticator code"]', "000000");
await page.locator("form.dialog button.primary").click();
await page.waitForSelector("text=wrong or was already used");
check("a wrong code is explained", true);
await page.fill('input[aria-label="Authenticator code"]', codeAt(key, stepNow() + 1));
await page.locator("form.dialog button.primary").click();
await page.waitForSelector("text=boss ·");
check("the right code signs in", true);
check("no script errors", errors.length === 0, errors.join(" | "));
await browser.close();
child.kill();
process.exit(ok ? 0 : 1);
