#!/usr/bin/env python3
"""X-02: DXF audit harness.

Reads each given DXF through ezdxf (https://ezdxf.mozman.at/, MIT) and runs
its structural auditor — the strictest free validator available without
ODA's converter (see README.md in this folder). Prints a JSON report per
file: {file, dxfversion, errors, fixes, entityCounts}. Exit code is nonzero
if any file has audit errors, so this is usable as a CI gate once it's
wired into one (not yet — ezdxf isn't a dependency of this repo, so CI
doesn't have Python/ezdxf available; this is a local/manual check, run via
`npm run dxf:audit -- <files>`).

If ezdxf isn't installed, prints a warning to stderr and exits 0 (skipped,
not failed) — this repo deliberately doesn't add Python to its toolchain
just for this.
"""

import json
import sys

try:
    import ezdxf
except ImportError:
    print("dxf-audit: ezdxf not installed (pip install ezdxf) — skipping", file=sys.stderr)
    sys.exit(0)


def audit_file(path: str) -> dict:
    doc = ezdxf.readfile(path)
    auditor = doc.audit()
    counts: dict[str, int] = {}
    for e in doc.modelspace():
        counts[e.dxftype()] = counts.get(e.dxftype(), 0) + 1
    return {
        "file": path,
        "dxfversion": doc.dxfversion,
        "errors": [getattr(err, "message", str(err)) for err in auditor.errors],
        "fixes": [getattr(fix, "message", str(fix)) for fix in auditor.fixes],
        "entityCounts": counts,
    }


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: audit.py <file.dxf> [more.dxf ...]", file=sys.stderr)
        return 2
    had_errors = False
    for path in argv:
        try:
            report = audit_file(path)
        except ezdxf.DXFStructureError as exc:
            report = {"file": path, "dxfversion": None, "errors": [str(exc)], "fixes": [], "entityCounts": {}}
        if report["errors"]:
            had_errors = True
        print(json.dumps(report))
    return 1 if had_errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
