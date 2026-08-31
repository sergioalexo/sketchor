# Plugin Marketplace — v1 Implementation Plan

Status: **Proposal.** Companion to [`plugin-architecture.md`](./plugin-architecture.md),
which owns the *why* and the long-term design. This doc is the *what* and *in
what order* for a shippable v1.

---

## Scope decision: what v1 is (and isn't)

The architecture doc lists interactive **tools** as build-order step 1. After
tracing the real code, that's wrong for v1. Tools are the *most* coupled
surface: `Viewport.tsx` drives them through one large `switch (tool)`
(~lines 549–740) entangled with snapping, selection, keyboard handling, and
per-tool state (measurement, straighten reference edge). Exposing that to
untrusted plugins is a big, risky refactor.

**v1 ships the low-coupling surfaces first** — the ones that reduce to "read the
document / selection → return `Command[]`" or "render self-contained UI":

| Surface | In v1? | Why |
|---|---|---|
| **Commands / actions** (run logic, mutate via `Command[]`) | ✅ yes | cleanest seam; `bus.execute` already takes a `batch` |
| **Geometry generators** (like `pattern`) | ✅ yes | same seam — selection in, `Command[]` out |
| **Importers / exporters** | ✅ yes | interfaces already implied by `dxf.ts`/`svg.ts` |
| **UI panels** (sandboxed iframe) | ✅ yes | self-contained; no viewport coupling |
| **Analyzers** (read-only overlays) | ⚠️ stretch | needs a read-model + overlay layer; include if time |
| **Interactive drawing tools** | ❌ deferred to v2 | requires decoupling the `Viewport` switch first |

Everything else from the architecture doc (signing, versioning, capabilities)
stays in v1 — those are foundational, not deferrable.

---

## Deliverables

1. `@sketchor/plugin-sdk` — typed authoring library (npm-publishable).
2. Plugin **host + sandbox runtime** in `apps/web`.
3. A **capability-enforced host API** contract in `packages/core`.
4. Two **first-party plugins** built on the public API (dogfooding).
5. **Manifest, signing, install flow**, loading from a local folder.
6. A **static registry + marketplace panel** for browse/install/update.

---

## Phase 0 — Contract & SDK skeleton (foundation)

Define the boundary before building either side of it.

**`packages/core`** (new files):
- `plugin/hostApi.ts` — the `PluginHostApi` interface: `document` (read-model +
  `apply(Command[])`), `selection`, `storage`, `network`, `ui`. Framework-free.
- `plugin/capabilities.ts` — permission enum + a `Capabilities` guard type.
- `plugin/manifest.ts` — `PluginManifest` type + a validator (zod or hand-rolled).
- `plugin/readModel.ts` — the safe, serializable projection of `SketchDocument`
  a plugin is allowed to see (entities, groups, layers; **no** internal `_put`
  handles).

**`packages/plugin-sdk`** (new workspace package):
- Thin typed wrappers that serialize calls to `postMessage` and await replies.
- Re-exports `Command` builders (`addLine`, `addCircle`, …) so authors never
  hand-assemble raw command objects.
- Ships `.d.ts` + a minimal runtime; versioned in lockstep with `hostApi.ts`.

**Acceptance:** SDK and host both compile against the shared `PluginHostApi`
type; no runtime yet.

---

## Phase 1 — Sandbox + RPC bridge (the hard core)

**`apps/web/src/plugins/` (new):**
- `sandbox/worker.ts` — the Web Worker entry that loads a plugin bundle and
  exposes the SDK inside it. No DOM, no `window.sketchor`.
- `rpc/bridge.ts` — Comlink-style typed RPC over `postMessage`; only
  structured-cloneable payloads cross. One request/response + event channel.
- `host/PluginHost.ts` — instantiates sandboxes, holds the capability table per
  plugin, and is the **only** place plugin intents become `bus.execute(batch)`.
- `host/capabilityGuard.ts` — checks the grant on *every* inbound call; a plugin
  without `write-document` cannot mutate no matter what it sends.

**Undo semantics:** every plugin action wraps its emitted commands in a single
`{ type: "batch" }` so it's one undo step. Enforced in `PluginHost`, not trusted
to the plugin.

**Acceptance:** a hardcoded in-repo test plugin, running in a worker, can read
the selection and add a line that appears on the canvas and undoes in one step —
and is *rejected* when it lacks `write-document`.

---

## Phase 2 — Contribution registries + first-party plugins

Turn "the host can run one hardcoded plugin" into "the host registers and routes
contributions."

- `host/registries.ts` — command, generator, and IO registries the host
  populates from each plugin's `contributes` block.
- Wire **commands** into a command-palette entry point and the menu.
- Wire **IO** so registered importers/exporters appear next to DXF/SVG.
- **Dogfood:** reimplement `pattern` (generator) and one IO format as
  first-party plugins over the *public* API. If a real feature can't be
  expressed, the API is wrong — fix it here, before third parties depend on it.

**Acceptance:** the pattern plugin, loaded as a plugin (not built-in), produces
identical results to today's `applyPattern`.

---

## Phase 3 — UI panels (sandboxed iframe)

- `sandbox/iframe.ts` — mount a plugin's `ui.html` in a
  `sandbox="allow-scripts"` iframe under a strict CSP; bridge it to the same RPC
  channel as the worker.
- A host-side panel container that docks plugin UIs alongside existing panels
  (Layers, Diagnostics, Pattern).
- SDK: `sketchor.ui.show(html)` / `postMessage` helpers, mirroring Figma's
  `showUI` ↔ `figma.ui.onmessage`.

**Acceptance:** a plugin panel with an input can drive a document change through
the worker, with the iframe unable to reach `window.sketchor` or the DOM
outside its frame.

---

## Phase 4 — Manifest, capabilities UI, signing, local install

- **Manifest loading** from a local dev folder (`~/.sketchor/plugins` on
  desktop via Tauri FS; a picked folder / IndexedDB in the browser).
- **Install flow:** parse manifest → check `engines.sketchor` semver → verify
  signature → **permission-grant prompt** → register contributions.
- **Signing:** publisher signs the bundle; Sketchor counter-signs on
  acceptance; host verifies before executing a line. Reuse the minisign tooling
  already in the repo for the desktop updater where practical.
- **Capabilities UI:** a per-plugin permissions view; grants revocable.
- `filesystem` capability wired through `src-tauri/src/main.rs`
  (`read_drawing_file` / `write_drawing_file`) — desktop only.

**Acceptance:** an unsigned or version-incompatible plugin is refused with a
clear reason; a signed one installs after the user approves its permissions.

---

## Phase 5 — Registry + marketplace panel

- **Static registry MVP:** a JSON index + signed bundles as GitHub release
  assets (no backend). An `install = fetch manifest → verify → download →
  Phase 4 flow`.
- **Marketplace panel:** browse/search the index, install, and show
  update-available by diffing installed vs. registry version. Reuse the app's
  existing update machinery in `apps/web/src/update`.

**Acceptance:** a user browses the registry, installs a plugin, and later sees +
applies an update — all from the panel.

---

## Cross-cutting: API versioning

- `PluginHostApi` is **semver'd independently** of the app version.
- Host refuses to load a plugin whose `engines.sketchor` doesn't satisfy the
  current API version — fail at load with a message, never at runtime.
- SDK version tracks the host API version.

Establish this in Phase 0 and hold the line every phase after.

---

## Sequencing & risk

```
Phase 0 ─► Phase 1 ─► Phase 2 ─► Phase 3
                        │
                        └─► Phase 4 ─► Phase 5
```

- **Phase 1 is the critical path and the highest risk** (sandbox + RPC +
  capability enforcement). Everything else is comparatively mechanical.
- Phases 2 and 3 can proceed in parallel once Phase 1 lands.
- Phases 4–5 are additive and can ship behind a feature flag.
- **Ship gate for a public v1:** Phase 4 (signing + capability enforcement)
  must be done before any third-party plugin loads. Phases 0–3 can ship as an
  internal/first-party-only capability earlier.

---

## Explicitly out of v1 (v2 backlog)

- Contributed **interactive drawing tools** — requires first decoupling the
  `Viewport` `switch (tool)` into a tool registry (its own project).
- Native/Rust/WASM-heavy plugins beyond what a worker allows.
- Marketplace backend with accounts, ratings, payments.
- Per-call CPU/time limits (QuickJS execution engine) — revisit if worker
  isolation proves insufficient.

---

## First concrete step

Phase 0, `packages/core/src/plugin/hostApi.ts` + `readModel.ts` — writing the
read-model forces the "what can a plugin see" decision, which everything else
depends on. Nothing here blocks on the tool refactor, so v1 can start today.
