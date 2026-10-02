# DXF audit harness (X-02)

Validates a DXF through [ezdxf](https://ezdxf.mozman.at/)'s structural
auditor — the strictest free validator available without a copy of ODA's
`ODAFileConverter`. Not wired into CI (this repo doesn't otherwise need
Python), so it's a local/manual check:

```bash
pip install ezdxf
npm run dxf:audit -- path/to/file.dxf [more.dxf ...]
```

Prints one JSON report per file (`{file, dxfversion, errors, fixes,
entityCounts}`) and exits nonzero if any file has audit errors. Missing
`ezdxf` prints a warning and exits 0 (skipped, not failed) rather than
blocking anyone without Python installed.

Used while developing `packages/core/src/dxfw/` (X-01, the AC1032 writer):
every fixture in `dxfw/index.test.ts` was round-tripped through this during
development and audited at zero errors. There's no golden-file regression
test wired into `npm test` yet (the plan's `dxf:golden` — diffing writer
output against fixtures in vitest) — that and an optional ODA DXF→DWG→DXF
round-trip (the strictest check there is, when `ODAFileConverter.exe` is
available) are still open.
