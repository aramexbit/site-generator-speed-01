# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/aramexbit/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/aramexbit/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in replacement for make.fun's own `makefun-site` 1.0.0 static site generator: it answers exactly as `makefun-site` does on every case — the same output tree, byte for byte (every page's `index.html`, the index and tag pages, `build-report.txt`, and every static file) — while using much less CPU.

## How it is fast

- **One pass per case.** Sources are parsed once; the template for each layout is compiled once into an operation tree and then interpreted per page.
- **Markdown without regex in the hot path.** Block dispatch on the first character, inline scanning with `indexOf`, and HTML escaping done once per text run.
- **Cached work.** Slugification, long dates (`9 November 2026`) and word counts are computed once per source and reused across the index, tag pages, cards and table of contents.
- **Minimal allocation.** Strings are built with arrays and `join`; no intermediate objects per line.

## Measured speed

On the competition's practice set (3 cases, 200–600 sources each), this entry is byte-identical to `makefun-site` 1.0.0 on all 3 cases, and its `run()` uses **~2.9× less CPU** than the house baseline measured side by side on the same machine (241,000 µs vs 706,000 µs total over the 3 cases). `grade-local` reproduces the 3/3 result byte for byte.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json`, answers each with `run` from `solve.js`, and writes `$MAKEFUN_OUTPUT_DIR/answers.json`. `solve.js` is a dependency-free ES module: `run(input)` returns the output tree for a case's site.

## Files

- `solve.js` — the generator (front matter, template dialect, Markdown subset, slug rule, report).
- `main.ts` — the driver the harness runs.
- `package.json` — `{"type": "module"}`.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rrcbfccn&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
