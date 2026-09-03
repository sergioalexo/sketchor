# Plugin Marketplace — Architecture Design

Status: **Draft / proposal.** Nothing here is built yet. This document describes
the target architecture for a third-party plugin system and marketplace for
Sketchor, in the style of VSCode extensions and Figma plugins.

> Read `CLAUDE.md` and `README.md` first. This doc assumes the "one
> architectural rule" (every document mutation is a serializable `Command`) and
> the runtime surface (`window.sketchor`) described there.

---

## 1. Goals & non-goals

**Goals**

- Third parties can extend Sketchor without a fork: new tools, importers/
  exporters, geometry generators, analyzers, and UI panels.
- Plugin code is **untrusted** — it runs in users' browsers and desktop
  installs, so it must never be able to corrupt a drawing or exfiltrate data
  without permission.
- One runtime that works identically in the browser and inside the Tauri
  webview.
- The host API is a **stable, versioned contract** — we can't hot-patch code we
  don't own.
- The same command-proposal pipeline serves plugins *and* the future AI
  assistant.

**Non-goals (for v1)**

- Native/Rust plugins. v1 is JavaScript/WASM in a sandbox only.
- Arbitrary DOM access or rendering directly to the main canvas.
- A social marketplace (reviews, publisher accounts, payments). Start with a
  signed static registry; add a backend later.

---

## 2. The core insight: the Command bus is already the security boundary

Sketchor's invariant — *the document only ever mutates through serializable
`Command` values*, applied by `CommandBus` (`packages/core/src/commands.ts`) —
is exactly the isolation boundary VSCode and Figma had to build from scratch.

A plugin **cannot** corrupt a drawing, because the only way to change one is to
emit a `Command`, and every `Command` flows through the same
`apply → inverse-derivation → undo/redo → emit` pipeline as first-party code.
This gives us the write-security model for free. The plugin system is therefore
mostly three wrappers around things that already exist:

1. an **isolation layer** (sandbox + RPC) around plugin code,
2. a **contribution registry** so plugins can register tools/commands/IO,
3. a **distribution & trust layer** (manifest, capabilities, signing, registry).

---

## 3. The central decision: the sandbox model

Two industry reference points:

- **VSCode** runs extensions in a separate Node process with broad API access
  and message-passing to the UI. Acceptable because it's desktop-only and
  extensions are semi-trusted.
- **Figma** runs plugin code in a sandboxed realm with **no DOM or network by
  default**, communicating with the host over `postMessage`. Right for
  untrusted code running inside a browser.

**Decision: adopt the Figma model.** Marketplace code is third-party and runs in
our users' browsers; it must never see `window.sketchor`, the canvas, or the DOM
directly.

```
┌────────────────────── main thread (React + Canvas2D) ──────────────────────┐
│  window.sketchor / store / CommandBus / viewport                           │
│                                                                            │
│  ┌── Plugin Host ─────────────────────────────────────────────────────┐   │
│  │  • loads manifests, owns the contribution registries               │   │
│  │  • RPC bridge (Comlink-style) over postMessage                     │   │
│  │  • enforces capabilities on every inbound call                     │   │
│  │  • translates plugin intents → Command → bus.execute()             │   │
│  └───────────▲───────────────────────────────────────────────────────┘   │
└──────────────┼─────────────────────────────────────────────────────────────┘
               │  postMessage (structured-clone / JSON only)
   ┌───────────▼──────────────┐        ┌──────────────────────────┐
   │  Sandbox: Web Worker     │        │  Sandbox: <iframe> (CSP) │
   │  plugin logic + SDK      │        │  plugin UI panel          │
   │  no DOM, no window.*     │        │  (Figma "showUI" model)  │
   └──────────────────────────┘        └──────────────────────────┘
```

- **Logic-only plugins** run in a **Web Worker**. No DOM, no ambient network —
  the plugin only reaches capabilities the SDK exposes.
- **Plugins with UI** get a **sandboxed `<iframe>`** (`sandbox="allow-scripts"`
  + strict CSP) mounted in a Sketchor panel, mirroring Figma's `figma.showUI`.
- Both talk to the host over **one typed RPC channel**. Only structured-cloneable
  data crosses — no functions, no live references.
- The same worker/iframe pair runs unchanged in the Tauri webview and the
  browser, so **the runtime is shared, not forked per platform**.

---

## 4. Extension points (contributions)

Each contribution kind is a registry the Plugin Host owns. Note how each maps to
code that exists today — the existing features are the proof the seams are in
the right place.

| Contribution | Maps to today | Work needed |
|---|---|---|
| **Commands / actions** (palette + menu items) | — | command registry + command-palette UI |
| **Tools** (new drawing tools) | `ToolId` union, `store.ts` | turn the hardcoded union into a **runtime tool registry** — the main refactor |
| **Importers / exporters** | `dxf.ts`, `svg.ts`, `dxfExport.ts` | a registrable IO-format interface |
| **Geometry generators / operations** | `pattern.ts`, `heal.ts`, straighten | "operate on selection → return `Command[]`" |
| **Analyzers** (read-only overlays) | heal/duplicates issue lists, `overlayEntities` | safe read-model + overlay-layer contribution |
| **UI panels** | — | the sandboxed-iframe path in §3 |

**Validation strategy:** rebuild one existing first-party feature (e.g.
`pattern` or `heal`) *as a plugin over the public API* before opening the API to
third parties. If a real feature can't be expressed cleanly, the API is wrong.

---

## 5. Manifest & capabilities

A plugin is a signed bundle: `manifest.json` + entry JS + optional UI assets.

```jsonc
{
  "id": "com.acme.gear-generator",
  "version": "1.2.0",
  "engines": { "sketchor": "^1.0.0" },   // host API is semver — see §7
  "main": "plugin.js",
  "ui": "ui.html",                        // optional, sandboxed iframe
  "contributes": {
    "tools":    [{ "id": "gear", "title": "Gear", "icon": "…" }],
    "commands": [{ "id": "gear.generate", "title": "Generate gear" }]
  },
  "permissions": ["read-document", "write-document", "network", "storage"]
}
```

**Capabilities are enforced at the RPC boundary, never by trust.**

| Permission | Gates |
|---|---|
| `read-document` | access to the read-model of the document |
| `write-document` | whether the host accepts `Command` intents from this plugin |
| `network` | a host-mediated `fetch` (the worker has none by default) |
| `storage` | a namespaced key/value store |
| `filesystem` | desktop only; backed by Tauri `read_drawing_file` / `write_drawing_file` |

The user grants permissions on install and can revoke them. The host checks the
grant on every inbound call, so a plugin without `write-document` literally
cannot mutate the drawing regardless of what it tries to send.

---

## 6. Monorepo layering

Split along the existing pure/UI seam:

- **`packages/core`** — the **contract**. `Command` (already here), a safe
  read-model of the document, capability tokens, and the `PluginHostApi`
  TypeScript interface. Framework-free, so web and any future headless/AI host
  share it.
- **`apps/web`** — the **runtime**. Worker/iframe sandbox, RPC bridge, capability
  enforcement, contribution registries, and all install/marketplace/panel UI.
- **`packages/plugin-sdk`** *(new, published to npm)* — the thin, typed library
  authors `import`. It turns `sketchor.document.addLine(a, b)` into a
  `postMessage` under the hood so authors never touch raw RPC or hand-build a
  `Command`. Versioned in lockstep with the host API.

---

## 7. API versioning (non-negotiable for a marketplace)

We cannot ship a breaking change and update third-party code the way we update
our own. Therefore:

- The `PluginHostApi` is **semver'd** independently of the app version.
- Every plugin declares `engines.sketchor`; the host **refuses to load**
  incompatible plugins rather than failing at runtime.
- The SDK version tracks the host API version so authors get compile-time
  compatibility.

Treat the host API like a public HTTP API: additive changes are cheap, breaking
changes are a major version and a migration story.

---

## 8. Distribution & trust

Start static; add a backend only when ratings/search/accounts justify it.

1. **Registry** = a JSON index + signed bundles on a CDN / object store. Install
   flow: fetch manifest → check `engines` → **verify signature** → download
   bundle → prompt for permissions → register contributions.
2. **Signing is mandatory** — this code runs in users' browsers. Publisher signs;
   Sketchor counter-signs on acceptance; the host verifies before executing a
   single line. This is the one thing **not** to defer.
3. **Updates** reuse the app's existing version machinery
   (`apps/web/src/update`), diffing installed vs. registry versions.

**MVP shortcut:** a GitHub repo *as* the registry — manifests in the repo,
signed bundles as release assets — skips standing up any backend.

---

## 9. Web / desktop parity

The plugin runtime (worker + iframe + RPC) is identical in both targets. Desktop
adds exactly one thing: the `filesystem` capability, mediated through the
existing Tauri commands in `src-tauri/src/main.rs`. No plugin logic branches on
platform; only the host's capability table differs.

---

## 10. AI convergence

The `toCode()` / `applyCode()` sketch-text surface and the plugin API are the
**same shape**: an untrusted-ish actor proposing `Command`s that the user
previews and accepts. Design the host API so the AI assistant is just another
(privileged) command producer with a deterministic author tag. **Do not build
two separate command-proposal pipelines.**

---

## 11. Build order (de-risks the hard parts first)

1. **Tool-registry refactor** — replace the hardcoded `ToolId` union with a
   runtime registry. Pure internal cleanup, no plugins yet, but load-bearing.
2. **Host API + SDK contract** in `packages/core` / `packages/plugin-sdk`, with
   capability enforcement.
3. **Worker sandbox + RPC bridge**; then rebuild `pattern` or `heal` as a
   first-party plugin over it — the API's first real user.
4. **iframe UI panels** (Figma `showUI` model).
5. **Manifest + install flow + signing**, loading from a local/dev folder.
6. **Registry backend + marketplace UI** last — the least architecturally risky
   part.

---

## 12. Open questions

- **Execution engine:** raw Web Worker vs. an embedded JS engine (QuickJS/WASM)
  for stronger determinism and CPU/time limits? Worker is simpler; QuickJS gives
  hard resource caps.
- **Geometry compute limits:** do we need per-call timeouts / cancellation for a
  plugin that produces millions of entities?
- **Selection & viewport API:** how much read access to viewport/selection state
  do analyzers get, and is any of it live vs. snapshot?
- **Undo semantics:** should a plugin action always collapse into a single
  `batch` command (one undo step)? (Recommendation: yes, by default.)
- **Signing authority:** who holds the Sketchor counter-sign key, and what's the
  review bar before a plugin is countersigned?
