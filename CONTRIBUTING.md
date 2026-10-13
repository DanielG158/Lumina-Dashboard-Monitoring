# Contributing

Thanks for helping. Bug reports, device modules and documentation fixes are all welcome.

## Set up

```bash
pnpm install
pnpm build
pnpm test:fast
```

Node 20 or later and pnpm 9 or later. `pnpm dev` runs the backend and the UI with reloading. `pnpm test` also runs the browser tests and needs Chromium (`npx playwright-core install chromium`).

## Adding a device type

A module is one file under `packages/modules/<name>/src/index.ts` that calls `defineModule` from `@lumina/sdk`. It declares its settings fields, a `poll()` that reads the device, optional `alerts(data)` and `metrics(data)`, and optional `actions`. Copy `packages/modules/apcupsd` (about 130 lines) as a starting point, and add a card in `packages/ui/src/components`.

Please:

- Keep anything that can change a device behind an action with the right `minRole`.
- Hide serial numbers, addresses and logs from anonymous viewers in `packages/core/src/redact.ts`.
- Add tests in `tests/` for new behaviour, and run `pnpm test:fast` before opening a pull request.
- Keep the UI usable on one screen with no scrolling on the Overview.

## Pull requests

Small, focused changes are easiest to review. Describe what changed and how you tested it. By contributing you agree your work is released under the MIT license.
