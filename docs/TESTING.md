# Testing

How to run the automated test suite, what it covers, how to add to it, and
how to manually verify the pipeline end to end using the seed and run-once
scripts.

## Contents

- [Automated tests](#automated-tests)
- [What's covered](#whats-covered)
- [Adding a test](#adding-a-test)
- [Type-checking](#type-checking)
- [Manual verification with seed + run-once](#manual-verification-with-seed--run-once)
- [Dry-run mode](#dry-run-mode)
- [Exercising a specific integration](#exercising-a-specific-integration)

## Automated tests

The test framework is Node's own built-in **`node:test`** runner plus
**`node:assert`** — there is no Jest, Vitest, Mocha, or any other test
dependency to install. Because there's no build step, the runner executes
the `.ts` test files directly.

```bash
npm test
# equivalent to: node --test
```

`node --test` auto-discovers test files under `tests/` (and any file
matching its default `*.test.*` conventions). Today there is one test
file, `tests/shared.test.ts`, containing:

- **11 `describe` blocks** grouping related behavior
- **33 individual `test()` cases**

Run a single file directly if you want faster iteration while writing a
new test:

```bash
node --test tests/shared.test.ts
```

## What's covered

`tests/shared.test.ts` covers the pure, dependency-free utility layer
(`src/shared/*`) — the lowest-level building blocks that the rest of the
app is built from, and the parts most amenable to fast, deterministic unit
testing with no network or filesystem dependencies (beyond one throwaway
temp file):

| Module under test | `describe` blocks | What's verified |
|---|---|---|
| `src/shared/crypto.ts` | `crypto: encryptSecret/decryptSecret`, `crypto: signJwtRs256`, `crypto: base64url` | AES-256-GCM roundtrip; ciphertext differs per call (random IV); decrypting with the wrong key throws; a too-short key is rejected; `signJwtRs256` produces a well-formed 3-segment, base64url-only JWT with correct header (`alg: RS256`, `typ: JWT`) and payload; custom headers merge over the RS256 defaults; `base64url` encoding has no `+`/`/`/padding and accepts string input |
| `src/shared/dotenv.ts` | `dotenv: loadDotenv / parseLine behavior` | `KEY=VALUE` parsing, comment-only lines produce nothing, inline `#` comments are stripped, a missing file returns `loaded: false` without throwing, an already-set env var is never overwritten |
| `src/shared/csv.ts` | `csv: parseCsvObjects + pick` | Simple header-keyed CSV parsing, quoted fields with embedded commas and escaped quotes, an empty string parses to `[]`, `pick` finds the first matching header case-insensitively while skipping blanks |
| `src/shared/clock.ts` | `clock: parseHhmm`, `clock: nextSlot`, `clock: localWallClockToIso` | Valid `HH:mm` parses to minutes-since-midnight and rejects malformed/out-of-range input; `nextSlot` returns the next valid slot at-or-after `from`, rolls over to the next day once today's slots have passed, and falls back to `from + 1h` when slots are missing or all malformed; `localWallClockToIso` converts a UTC wall-clock correctly, accounts for a fixed negative offset (America/New_York summer, UTC-4), and returns `null` for malformed input |
| `src/shared/ids.ts` | `ids: ulid`, `ids: productDedupeKey`, `ids: slugify` | ULIDs are 26-character Crockford base32 and sort increasingly by timestamp prefix (including two minted in the same millisecond); `productDedupeKey` is stable across case/whitespace differences, changes when any identifying part changes, and is deterministic across repeated calls; `slugify` lowercases and hyphenates, truncates to a max length, and falls back to `"item"` for input that would otherwise produce an empty slug |

Everything above `src/shared/` — the pipeline orchestrator, the source and
publisher adapters, the AI/image/video renderers, the two Sheet store
implementations, the HTTP routes, and the worker/queue — has **no
automated test coverage today**. That layer is verified manually, via the
seed/run-once workflow and `DRY_RUN` described below, rather than through
`node --test`.

## Adding a test

Follow the existing file's pattern: import `test`/`describe` from
`node:test` and `assert` from `node:assert/strict`, group related cases
under a `describe`, and keep each `test()` focused on one behavior.

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { yourFunction } from '../src/shared/your-module.ts';

describe('your-module: yourFunction', () => {
  test('does the thing you expect', () => {
    assert.equal(yourFunction('input'), 'expected-output');
  });
});
```

Either add cases to `tests/shared.test.ts` if they belong to a module
already covered there, or create a new `tests/*.test.ts` file — `node
--test` picks up any matching file under `tests/` automatically, no
registration step needed. If a new test needs real filesystem access, use
`node:fs`'s `mkdtempSync(join(tmpdir(), ...))` pattern already used for the
`dotenv` tests rather than writing into the repository itself, and clean
up with `rmSync` when done.

## Type-checking

`tsc` is used purely for static type-checking — the project has
`"noEmit": true` in `tsconfig.json`, so it never produces output; Node
still executes the original `.ts` sources directly via native
type-stripping.

```bash
npm run typecheck
# equivalent to: tsc --noEmit
```

Run this after any non-trivial change; `noUncheckedIndexedAccess` and
`strict` are both enabled in `tsconfig.json`, so the type-checker is fairly
aggressive about catching `undefined`-from-index-access and null-safety
issues before they become runtime bugs.

## Manual verification with seed + run-once

For everything the automated suite doesn't cover, the fastest
zero-credential smoke test is the seed + run-once combination:

```bash
node scripts/seed.ts
```

This provisions a demo brand ("Acme Audio", with a specific color
palette/watermark/CTA) and two demo products — "Aurora Wireless
Headphones" (with an embedded product photo, if one is found, or a
branded placeholder is generated otherwise) and "Nova Fitness Smartwatch"
(no photo, always uses the branded placeholder path) — as `NEW` rows,
using the local Sheet store so no Google credentials are involved.

```bash
node scripts/run-once.ts
```

This claims every currently-claimable row and runs
`orchestrator.process(row)` **directly and synchronously**, one row at a
time, with no job queue involved — the fastest way to see the entire
six-stage pipeline (import → copy → creative assets → video → publish →
write-back) execute against real code paths, end to end, in a single
command. It logs a pass/fail line per product and finishes by writing an
analytics snapshot and printing the dashboard summary. If it reports no
claimable rows, run `scripts/seed.ts` first (its own warning message says
exactly this).

Inspect the result either via the dashboard (`node src/main.ts`, then open
http://localhost:8080) or directly against the API:

```bash
curl http://localhost:8080/api/products
curl http://localhost:8080/api/content
curl http://localhost:8080/api/videos
```

Note that `run-once.ts` bypasses the job queue entirely — it is a
verification/debugging tool, not a substitute for the worker in
production. To verify the actual production code path (polling → claiming
→ enqueueing → the retry/backoff-aware drain loop), run `node src/main.ts`
or `node src/boot/worker.ts` instead and watch it pick up seeded rows on
its own polling interval, or trigger an immediate poll+drain via:

```bash
curl -X POST http://localhost:8080/api/actions/run
```

## Dry-run mode

`DRY_RUN=true` is the default in `.env.example`, and every publisher
additionally self-disables into dry-run behavior if its own platform
credentials are missing — regardless of the global flag. This means the
full pipeline, including the "publish" stage, can be verified without ever
risking a real post:

- Each publisher returns `{status: 'dry_run', raw: {wouldPost: true, ...}}`
  instead of calling its platform's API.
- The row still progresses to `POSTED` status in the Sheet/dashboard, with
  a dry-run summary recorded in place of a real permalink.
- Analytics still records the attempt, so dashboard rollups behave
  identically to a live run.

This is the recommended way to validate a brand-new source integration or
a copy/creative change before flipping `DRY_RUN=false` (and filling in a
specific publisher's credentials) for a real platform.

## Exercising a specific integration

To verify one specific source or publisher rather than the whole demo
flow:

1. Set that integration's credentials in `.env` (see
   [`docs/SETUP.md`](SETUP.md) for exactly which variables each one
   needs).
2. Confirm it now reports `configured: true`:
   ```bash
   curl http://localhost:8080/api/health
   ```
3. Add a single product through that source, either via the API:
   ```bash
   curl -X POST http://localhost:8080/api/products \
     -H 'content-type: application/json' \
     -d '{"source":"shopify","productId":"<a real product id>","platform":"instagram"}'
   ```
   or by adding a row directly to the Sheet with that `Product Source`.
4. Trigger processing (`node scripts/run-once.ts`, or
   `POST /api/actions/run`, or just wait for the next poll) and inspect the
   resulting row/product detail via `GET /api/products/:id` — this returns
   the imported product's generated content, assets, video, and
   publication results together, which is the fastest way to see exactly
   where in the six stages a new integration succeeds or fails.
5. Leave `DRY_RUN=true` (or that publisher's credentials unset) until
   you're confident in the copy/creative output — flip to a live post only
   once you've reviewed a dry-run result.
