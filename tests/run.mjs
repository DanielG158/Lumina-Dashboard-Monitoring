// Runs every test file in this folder one after another and fails if any of them fails.
//   pnpm test               everything (needs a Chromium: npx playwright-core install chromium)
//   pnpm test -- --no-ui    only the tests that do not open a browser
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const noUi = process.argv.includes("--no-ui");
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs") && !(noUi && /-ui\.test|security/.test(f))).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f}`);
  const r = spawnSync("node", [join(dir, f)], { stdio: "inherit", timeout: 10 * 60_000 });
  if (r.status !== 0) { failed += 1; console.log(`*** ${f} FAILED (exit ${r.status})`); }
}
console.log(failed ? `\n${failed} of ${files.length} test files failed` : `\nall ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
