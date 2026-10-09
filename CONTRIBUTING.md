# Contributing to Sketchor

Thanks for looking. Sketchor is a parametric 2D CAD sketcher (web + Tauri desktop). Small, focused contributions are very welcome; browse the issues labelled [good first issue](https://github.com/sergioalexo/sketchor/labels/good%20first%20issue).

## Set up

```bash
npm i && npm run dev     # web app at http://localhost:5173
```

Open `http://localhost:5173/?demo` to load the built-in showcase drawing, `?blank` to skip it. The desktop shell (`npm run desktop`) needs a Rust toolchain; you rarely need it.

## Check your work

```bash
npm test                          # vitest, whole workspace
npx vitest run packages/core/src/dxf.test.ts   # one file
npm run build                     # builds core, then web (typechecks tests too)
cd apps/web && npx tsc --noEmit   # what release CI runs; no Node types in apps/web
```

All three must be green before a PR. Tests live next to the code (`foo.ts` -> `foo.test.ts`). Prefer round-trip and property tests over golden strings; a parser of user files must be tested with empty, truncated and malformed input.

## Architecture in ten lines

1. The document changes **only through serializable `Command` values** (`add-entity`, `move-entities`, `batch`, ...). `CommandBus` applies them and derives undo/redo. Tools, the solver and plugins are all just command producers.
2. `packages/core` is pure TypeScript (no DOM, no React): document model, commands, geometry, DXF/SVG/EPS/PDF IO, hatch, blocks, dimensions, solver. Vitest tests sit beside the code.
3. `apps/web` is the React UI and a custom Canvas2D viewport; it emits Commands only.
4. Every entity `type` is one registered `EntityKind` in `packages/core/src/kinds/`. **New entity type: follow [docs/new-entity-checklist.md](docs/new-entity-checklist.md).**
5. Drawing tools are state machines on the framework in `apps/web/src/tools/tool.ts`; geometry maths goes in `packages/core` with a test, the tool only collects picks.
6. A new field the sketch-code text view cannot express must be carried in `diffToCommands` (`packages/core/src/sketchtext.ts`).
7. `apps/web/src-tauri` is the Rust desktop shell; `native/` holds Rust readers and Explorer/Finder thumbnailers.
8. Plugins (`packages/plugin-*`) run in a sandbox and talk to the host through `@sketchor/plugin-sdk`.
9. `CLAUDE.md` has the detailed wiring notes per subsystem; `docs/cad-fidelity-plan.md` is the roadmap with `[ ]`/`[~]`/`[x]` status.
10. Never import `node:*` in `apps/web/src`; use Vite `?raw` imports.

## Conventions

- **Do not run prettier.** There is no config; it reformats the whole file and produces huge diffs. Match the surrounding style.
- Commit subjects are `ID: summary` where ID is a roadmap id (`H-08`, `SV-04`) or a short area (`Docs`, `Web`, `Fix`), e.g. `H-08: send hatch behind boundary`.
- One logical change per commit. If you finish or partly finish a roadmap item, tick it in `docs/cad-fidelity-plan.md` and add one progress-log row.
- Never commit customer drawings or private sample files; tests use small inline or synthetic fixtures.

## Writing a plugin

Plugins add commands, panels and exporters without touching the core. Start with [docs/plugin-architecture.md](docs/plugin-architecture.md), then copy the smallest package in `packages/` (e.g. `plugin-gcode`) and the built-in examples in `apps/web/src/plugins/builtins/`.

## About AI-written code

Much of Sketchor is written with AI agents working under tests and review: every change lands with tests, a green build and a human-reviewed direction. Human pull requests are very welcome, and they are reviewed by hand, not by a bot. If something in the code looks odd, ask in an issue; it may just be a leftover that nobody has cleaned up yet.

## Reporting bugs

Use the bug-report template. If a file fails to open or renders wrong, attach it (or a minimal version of it); that is the single most useful thing you can give us.

## License

By contributing you agree your work is released under the repository's license (see [LICENSE](LICENSE)).
