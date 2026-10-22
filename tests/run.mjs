// Runs every test file in this folder one after another and fails if any of them fails.
//   pnpm test               everything (needs a Chromium: npx playwright-core install chromium)
//   pnpm test -- --no-ui    only the tests that do not open a browser
// On GitHub Actions each failure is also reported as an annotation, so the reason is visible without opening the full log.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const noUi = process.argv.includes("--no-ui");
const ci = process.env.GITHUB_ACTIONS === "true";
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs") && !(noUi && /-ui\.test|security/.test(f))).sort();
const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f}`);
  const r = spawnSync("node", [join(dir, f)], { encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  if (r.status !== 0) {
    failed += 1;
    console.log(`*** ${f} FAILED (exit ${r.status}${r.signal ? `, ${r.signal}` : ""})`);
    if (ci) {
      const lines = out.split("\n");
      const fails = lines.filter((l) => /^FAIL\b/.test(l)).slice(0, 8);
      const tail = lines.filter((l) => l.trim()).slice(-8);
      console.log(`::error file=tests/${f},title=${f} failed::${esc([...fails, ...(fails.length ? [] : tail)].join("\n") || `exit ${r.status}`)}`);
    }
  }
}
console.log(failed ? `\n${failed} of ${files.length} test files failed` : `\nall ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
