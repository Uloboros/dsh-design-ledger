# dsh-design-ledger

[中文（Chinese）](README.md) · **English**

Turn your **design documents** into a **live development progress tree**, and let DSH agents pick up where the last session left off.

Built for long-running projects (games / software) developed in one workspace over many sessions, where a single session's context window runs out. The plugin turns "design document → progress checklist → code index" into structured data that is durable, queryable, and injectable, so a fresh session can continue the work.

## Understand it in 30 seconds

```
design document (.md / folder)      progress tree (generated & maintained here)
┌──────────────────────┐            ┌──────────────────────────────────┐
│ 03_systems/          │  parse     │ index.json   index (auto-injected)│
│   S01_core_gameplay/ │ ─────────► │ systems/     full subtree/system  │
│     design.md        │            │   S01_....json                   │
│   S02_base_building/ │            │ state/       volatile (gitignore) │
│     design.md        │            └──────────────────────────────────┘
└──────────────────────┘                            │
                                                    │ inject
                                      ┌─────────────▼───────────┐
                                      │ DSH session context      │
                                      │ · task-opening prompt    │
                                      │ · index (systems, %)     │
                                      │ · currently focused tree │
                                      └──────────────────────────┘
```

## Why not just dump the design document into context

A real design document measured on this machine: **19 `.md` files / 588 KB / 226,885 characters ≈ 133,000 tokens**.

| Content | Size | Injectable every turn? |
|---|---|---|
| Task-opening prompt | a few hundred characters | ✅ yes |
| The whole design document | ≈133k tokens | ❌ **infeasible** (one system doc alone ≈65k) |
| Progress index | a few KB | ✅ yes |
| Currently focused subtree | a few KB | ✅ yes |
| Remaining subtrees / code index / bug details | large | ❌ read on demand |

So injection is **layered**: the index is resident, the focused subtree is resident, everything else is on demand. That is not a compromise — it is the only sustainable approach.

## Injection strategy

| Layer | Content | When |
|---|---|---|
| L0 | **Task-opening prompt** (verbatim) | injected once, at first assembly of a session |
| L1 | **Index**: systems + completion + file pointers | every session |
| L2 | **Currently focused subtree** (nodes with `marked` first) | every session |
| L3 | Remaining subtrees, code index, bug details | not injected — `design_ledger_read` on demand |
| L4 | Design document text | not injected — `design_doc_read` on demand |

Injection goes through the `system-prompt/assemble` waterfall — the same seam `dsh-agent-instructions` uses to inject `AGENTS.md`.

## Progress tree data model

Every node is one "row" with a fixed set of fields, so tools can parse it and you can hand-edit it:

| Field | Meaning |
|---|---|
| `id` | Stable identifier (derived from the hierarchy, e.g. `S02/moduleA/feature1`) |
| `name` | **Node name = the name used in the design document** (falls back to the folder/feature name) |
| `kind` | `system` / `subsystem` / `feature` / `subfeature` / `task` |
| `status` | `todo` / `doing` / `done` / `blocked` / `dropped` |
| `parentId` / `children` | Parent/child links (form the tree) |
| `designRefs` | **Design document pointers**: `{ file, heading?, anchor? }` |
| `codeRefs` | **Code index**: `{ file, symbol }` — file + symbol name only, never line numbers |
| `interfaces` | Public interfaces / contracts |
| `bugs` | `{ id, summary, status, codeRef?, designRef? }` |
| `notes` | Free-form notes |
| `marked` | Whether this is the "currently focused" node (injection priority) |

**Why the code index stores only "file + symbol"**: line numbers drift as you edit; symbol names are stable. "Lines 10–25" belongs in your editor/IDE, not in the ledger.

## ⚠️ Pitfalls hit while building this plugin (read this first)

Every item below either **broke DSH**, **silently disabled a feature**, or produced a confusing display. The causes are non-obvious. Read this section before changing the plugin.

### Crash 1: calling a non-existent client API inside the client half → the host sidebar dies too

```
Uncaught TypeError: ctx.locale.get is not a function
Error: web boot: 1 entry did not activate
@deepseek-ai/dsh-client-ui-sidebar: failed      ← a HOST entry fails
```

**Mechanism**: any uncaught exception in the client half's `apply()` makes the host mark that entry "not activated", and it **also** fails the host entries that depend on it (here `dsh-client-ui-sidebar`) — the whole Web app then fails to boot.

**Root cause**: `ctx.locale` has **no `get` method**. The real API is only:

| API | Signature | Purpose |
|---|---|---|
| `ctx.locale.register(ns, dict)` | `(ns: string, dict: LocaleDict) => () => void` | register a dictionary (flat `Record<string,string>`) |
| `ctx.locale.bind(ns)` | `(ns: string) => Translate` | get a translate function that reads the active locale *when called* |

**Fix and discipline**: translate via `bind` plus a local fallback, wrap **every** fallible action in its own `try/catch`, and add one more catch-all `apply()` around everything so it can never throw outward (`apply` / `applyInner` in `client/client.js` exist for exactly this).

### Crash 2: exporting a `Config` without a schema → cordis calls `.validate` and throws

```
TypeError: Cannot read properties of undefined (reading 'validate')
  at resolveConfig (cordis/lib/index.js:958)
```

**Mechanism**: cordis resolves config like this:

```js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config          // ← no Config: returned as-is
  const result = runtime.Config['~standard'].validate(config)   // ← otherwise a schema is required
  ...
}
```

So you must **either** export a schemastery schema carrying `~standard`, **or** export no `Config` at all. Exporting a plain object (which this plugin did once, to drop the schemastery dependency) hits `.validate` and fails bundle activation.

**Current approach**: no `Config` export; defaults live in the internal `DEFAULTS` and are read defensively by `readConfig(ctx.config)`. To expose configurable options later, add `@deepseek-ai/schemastery` and export `Schema.object({...})`.

> Note: this one surfaced during **hot reload** (a running host caches the old module object; ESM caches by URL, so editing a file does not clear it). After changing plugin code, **restart the whole app** before judging the result — do not trust HMR's immediate output.

### Crash 3: a `WebRoute` without `kind` → the route silently never matches

**Symptom**: plugin is `fiberPhase: active`, yet every `/design-ledger/*` request returns **404**.

**Mechanism**: the real `WebRoute` contract is

```ts
interface WebRoute {
  kind: 'exact' | 'prefix'   // ← required
  path: string
  handler: (req, res) => void | Promise<void>
}
```

There is **no `method` field**. Writing `{ method: 'GET', path, handler }` makes `register()` throw — and because the call was wrapped in a defensive `try/catch`, the failure was swallowed: no routes, plugin still looked healthy. Defensive `try/catch` turns contract errors into silent failures.

**Fix**: register routes inside the service injection scope, and treat every registration outcome as observable:

```js
ctx.inject(['webServer'], (sctx) => sctx.webServer.register({ kind: 'exact', path, handler }))
```

### Crash 4: inventing theme tokens → unreadable dark panel / white-on-white hover

**Symptoms (twice, same root cause)**:

1. the modal was "too dark, text unreadable" in a light theme;
2. **hovering "Choose design document" / "Load as design document" turned the background white while the text stayed white — the label vanished.**

**Mechanism**: colour tokens must be copied from official components; guessing by name does not work. Both incidents came from that:

| What this plugin wrote | Reality |
|---|---|
| `--dsw-alias-bg-1` / `--dsw-alias-text-1` | **do not exist** in DSH → the hardcoded dark fallback always won |
| `--dsw-alias-bg-layer-2` as a hover surface | exists, but in a **light theme it is pure white** (measured: `var(--dsw-static-neutral-bluish-00)` = `#fff`) |

The second one was compounded by a cascade problem: `.dlg-btn:hover` and `.dlg-primary` have the **same specificity (0,2,0)**, and the primary button hardcoded its own background/text (brand fill + `color:#fff`); once the hover rule overrode the background it became white background + white text.

**The correct source**: don't guess — read the official component CSS. `Button.module.css` in `@deepseek-ai/dsh-client-ui-primitives` is authoritative:

```css
.primary            { background: var(--dsw-alias-button-primary-fill);   color: var(--dsw-alias-label-primary-foreground); }
.primary:hover      { background: var(--dsw-alias-button-primary-hover); }
.ghost:hover        { background: var(--dsw-alias-interactive-bg-hover); }
.outline            { border: 0.5px solid var(--dsw-alias-border-l3); }
.outline:hover      { background: var(--dsw-alias-interactive-bg-hover); }
```

**Key values** (real definitions read from the theme CSS):

| Token | Light | Dark | Use |
|---|---|---|---|
| `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` | **the default interactive surface** (translucent, safe in both themes) |
| `--dsw-alias-button-primary-fill` | `var(--dsw-alias-brand-primary)` | same | primary button fill |
| `--dsw-alias-button-primary-hover` | `var(--dsw-static-neutral-bluish-750)` | `…-100` | primary hover (**its own rule**) |
| `--dsw-alias-label-primary-foreground` | `#fff` | `#0f1115` | primary button label |
| `--dsw-alias-bg-layer-2` | **`#fff`** | `#2b2b2b` | a raised surface — **never an interactive surface** |

**Rule**: interactive backgrounds always use `--dsw-alias-interactive-bg-hover`; primary buttons use the button-primary trio; every hover is written `:hover:not(:disabled)`. `npm run check:client` asserts all of this so it cannot regress.

> **`Theme.listTokens` only lists 14 tokens — it is a subset** and does not include the button/interactive families used above. So pick tokens from official component CSS, not from that inspect list alone.

### Crash 5 (worst): a non-string `systemPrompt` section text → **every message fails instantly**

```
Turn failed
text.indexOf is not a function          UNKNOWN
```

**Symptom**: as long as the plugin is enabled, **no message can be sent** — each one immediately shows a red "turn failed". This is far worse than a broken panel: the panel being broken still leaves you a working conversation; this kills the conversation itself.

**Mechanism** (from `@deepseek-ai/dsh-system-prompt`): on **every** turn, the host resolves **every** registered section like this:

```js
// assemble()
text: typeof section.text === 'function' ? section.text(context) : section.text
// then renderPrompt(assembly) → interpolate()
for (let open = text.indexOf('{{'); …)   // ← the very first line
```

So `PromptSection.text` is contractually `string | ((context) => string)` and **must return a string synchronously**. Return a `Promise` / object / `undefined` and `interpolate()` throws `TypeError: text.indexOf is not a function` — at the **start of a turn**, which is why the whole conversation becomes unusable.

**Fix** (the injection section of `lib/index.js`):
1. `text()` reads **only an in-memory cache** — no file I/O, no `await`, never a Promise;
2. the text is precomputed by a background task (`refreshInjectionCache`), warmed once in `apply()` and recomputed via `invalidateInjection()` after every ledger change;
3. staleness is one `statSync(index.json).mtimeMs` comparison, not a file read per turn;
4. the exit path re-checks `typeof !== 'string' → ''` and writes an `INJECT-NONSTRING` diagnostic.

**Discipline**: never write `async text()`. A failed render may cost you injected content; it must never affect the conversation.

### Crash 6: `defineTool` given a pre-compiled root schema → **all six tools silently disappear**

**Symptom**: plugin is `fiberPhase: active`, injection works, panel works — but **none** of the `design_ledger_*` / `design_doc_*` tools exist (the model gets "unknown tool"). The plugin logged a single `warn` line, easy to mistake for "fine".

**Mechanism**: official `defineTool(options)` expects `options.parameters` to be an **implicit property map**:

```js
// ✅ correct: a property map, with requiredness annotated per property
parameters: { rel: { type: 'string', description: '…', required: true } }

// ❌ wrong: hand-compiling the root schema
parameters: { type: 'object', properties: { rel: {...} } }
// → defineTool throws at construction time:
//   unsupported JSON schema: parameters.type must be a value schema object
//   (parameterSchemaSpecToJsonSchema treats it as a *value* schema node,
//    and an "object" value node demands an explicit additionalProperties)
```

Because the plugin wrapped construction errors into "skip this tool", the result was **all six skipped** while the plugin still looked perfectly healthy. Defensive `try/catch` again converted a contract error into a silent failure.

**Discipline**: the `defineTool()` adapter in `lib/index.js` only (a) flattens a top-level `required: []` onto the properties and (b) fills in `type: 'string'` for scalars missing a type. **Never hand-build the root schema.** Also: object-typed properties must declare `additionalProperties` explicitly, and do **not** add `items` to `type: 'array'` (it makes argument validation try to match element shapes).

### Crash 7: the panel treated the **deployment default root** as the workspace → empty dialog, and "workspace root" could not be navigated back to

**Symptom**: the sidebar panel opens fine, but "Choose design document" shows
"(no subfolder or .md file here)"; clicking the "workspace root" breadcrumb never returns to the real workspace — because that root had already been **locked in** as the workspace.

**Mechanism**: host routes have **no session context**, so `sandboxPolicy.resolve()` returns the **deployment default root** (on this machine `D:\AppData\.dsh\profiles\desktop`), not the user's workspace. The fact of "which workspace" exists **only on the session side**: `exec.agent.session` in tool calls, and agent events. The panel could not know it, and the route could not guess it — so it listed the profile directory.

**Fix** (four layers, all required):

1. **Side-channel session workspace** (`rememberSessionWorkspace`): any resolution that has a session (tool calls, `agent/created`, `agent/pre-step`) records the workspace; session-less routes default to that record. This is what makes even an **older panel build** land on the right workspace.
2. **Proactive discovery** (`discoverSessionWorkspace`): the plugin may load **after** a session was born (bundle just registered, hot reload, host restart ordering), in which case the events never arrive. So `apply()` and the route fallback both actively ask `ctx.agents.list()` and resolve the workspace from a live agent.
3. **Never accept a deployment root** (`isDeploymentRoot`): anything matching `/.dsh/profiles/<name>`, `/node_modules`, or the user's home directory is neither a default nor confirmable — it returns 400 and the panel says "workspace unknown". This is what prevents being locked inside the profile directory with no way back.
4. **The panel passes `workspace` explicitly** (taken from the status payload) and `resolveWs()` accepts only the first confirmed workspace, then requires consistency.

**The second version of the same trap: inventing an event name.** The first fix listened for `agent/session-start` — **DSH has no such event** (the real ones are `agent/created`, `agent/pre-step`, `agent/status`, …). It therefore never fired except by one timing coincidence, and the panel fell back to "workspace unknown".
**Discipline**: verify seam names (events, services, fields) against the source or type definitions; never write what it "sounds like it should be called". And always leave a path that does **not** depend on events (here: `agents.list()`).

**Lesson**: on a session-less endpoint, `sandboxPolicy.resolve()` does **not** return the user's workspace — you must learn it from the session side. Also: **"the panel opens" is not evidence that "the root is right"**; on this machine the root was only exposed as wrong after the client was fixed enough to display it.

### Verification order when changing this plugin (**for people editing the code; users can skip this**)

> If you only want to use the plugin, you can stop here and jump to "UI language (i18n)" or
> "Design document parsing rules" below. These commands are for developing this repository and need Node;
> the ⭐ probes additionally need DSH installed locally (see the note after the repository layout).

```powershell
npm run verify                                                            # syntax + unit tests + docs check + client check + contract (one command)
node --import ./probe/register.mjs probe/import-probe.mjs                 # does it import?
npm test                                                                  # 13 unit tests
node probe/client-ui-test.mjs                                             # ⭐ client UI: button contrast / dictionary completeness / locale wiring (no DSH needed)
node --import ./probe/register.mjs probe/contract-test.mjs                # ⭐ contract self-check (crashes 5/6 + route registration)
node --import ./probe/register.mjs probe/panel-list-test.mjs <workspace>  # ⭐ panel data (crash 7 + out-of-bounds rejection)
node --import ./probe/register.mjs probe/table-tree.mjs <design-doc>      # ⭐ table rows → feature nodes (read-only)
node --import ./probe/register.mjs probe/host-smoke.mjs <design-doc> <workspace>  # host end-to-end
node --import ./probe/register.mjs probe/route-test.mjs <design-doc>      # routes and path safety
```

`probe/client-ui-test.mjs` and `probe/readme-check.mjs` are **zero-dependency** (Node only), so they also run in CI;
the remaining probes need this machine's DSH dependency layer and are local-only.

`probe/contract-test.mjs` is the **regression guard** that pins down the contracts which silently destroy functionality:

| Assertion | Which crash it guards |
|---|---|
| `section.text()` returns a `string` synchronously and a host-style `interpolate` does not throw | Crash 5 (dead conversation) |
| All 6 tools register and `parameters` is an object-rooted schema | Crash 6 (tools silently missing) |
| `ctx.inject(['webServer'])` registers 3 routes; no false positive when the service is not ready, retry covers it once it is | Panel `Unexpected end of JSON input` |
| Once the session workspace is known, `list`/`status` use it; deployment root / out-of-bounds / `node_modules` always 400 | Crash 7 (empty dialog + root you cannot leave) |
| With no ledger / a corrupt ledger JSON, injection degrades to `''` and never throws | Edge cases of crash 5 |

`probe/client-ui-test.mjs` guards the **UI** side:

| Assertion | What it prevents |
|---|---|
| Interactive surfaces never use `--dsw-alias-bg-layer-2` (pure white in a light theme) | white-on-white hover |
| Ghost/list hover uses `--dsw-alias-interactive-bg-hover` | same |
| Primary buttons use the button-primary trio, with their own hover rule | primary label vanishing on hover |
| The primary label is no longer a hardcoded `#fff` | contrast mismatch across themes |
| `zh` / `en` key sets match, and every key used in code has both | raw keys leaking into the UI |
| Slots declare the `locale` namespace and no longer self-inject `t` | language not following DSH + duplicate prop failing slot assembly |

## UI language (i18n)

Panel copy **follows the DSH language setting** (DSH's built-in locale ids are only `zh` and `en`):

```js
// 1) register both dictionaries (one call covers every built-in locale)
ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'design-ledger: dictionaries')

// 2) declare the locale namespace on the slot → the renderer injects a REACTIVE t seat
ctx.slots.register({ name: 'main', key: PANEL_ID, locale: LOCALE_NS }, LedgerPanel)
```

The mechanics below were read out of the sources, not guessed:

- The renderer's `standardKit()` runs `kit["t"] = localeSeat(face, entry.locale)` whenever
  `entry.locale !== undefined`, and subscribes via `useLocaleRevision()` — so **`props.t` inside a component
  is reactive out of the box and a language switch re-renders immediately**; the plugin need not subscribe itself.
- **Therefore never `inject: () => ({ t })` yourself**: the renderer's `assertNoPropOverlap()` throws a
  `SlotAssemblyError` on a duplicate prop, which is an assembly-time error that fails the whole entry.
- The sidebar button text (`label`) is read by **the sidebar**, which re-resolves every panel label on each
  locale change via `ctx.locale.subscribe(syncPanels)` — so a `label` that returns "the text for the current
  locale" follows automatically, with no extra notification.
- When a lookup fails, the framework's `t` **returns the key itself** (not `undefined`), so any local
  fallback must first test "is this equal to the key".

## Design document parsing rules

Two kinds of input are supported.

### 1. A single `.md` file
The tree is built from Markdown heading levels (`#` / `##` / `###` …).

### 2. A folder (recursive)
The hierarchy is inferred from the directory structure — the most reliable approach under a strict project layout:

| Directory pattern | Inferred as |
|---|---|
| `NN_<name>/` (numeric prefix) | top-level group / system, name taken from `<name>` |
| `S0N_<name>/` | **system** |
| `SNN_<name>/` | subsystem |
| `design.md` | the **design body** for that level |
| `analysis.md` | the **analysis** for that level (extra `designRef`, no node; its size is recorded as `analysisTokens`) |
| other `*.md` | attached to the nearest ancestor as supporting material |

Node names **prefer the name used in the design document** (its heading); falling back to the folder name when there is no heading.

### 3. Table rows → feature nodes (`expandTableRows`)

**Why this exists**: many projects only nest directories down to `S0X_<name>/`, while the real content lives in **tables** inside `design.md` (one `XXX_001` item per row, with the table carrying its own "current status" column). Building the tree from directories alone leaves every system empty, and the agent has no actionable feature nodes.

| Rule | Detail |
|---|---|
| What counts as a "feature table" | **The first column is an ID column**, and **every** data row's first cell matches `PREFIX_digits` (`BFT_001` / `TEC_009` / `DEV_001`) |
| What does not count | Ordinary tables like `白天预报与建设 \| S01、S02` — first column is not an ID, **no nodes** (2 such tables were correctly ignored on a real corpus) |
| Node id | `<parent id>/<table heading>#<row id>`, e.g. `03_systems/S03_progression_economy/局外通用科技树表#TEC_001` |
| Node name | taken from the "name" column; when it says "TBD", a readable name is composed from the same row's category/target (e.g. `TEC_002（通用科技）`) |
| Node notes | the table's "current status" column, verbatim (e.g. "机制已明确，名称待定"), rendered as `备注: …` |
| `designRefs` | `{ file, heading: <table heading>, anchor: <row id> }` — `anchor` is that row's ID, so you can jump straight back to it |
| `docTokens` | the size of the **section** containing that table (from `parseStructure`'s section accounting) |

**Strategy** (`expandTableRows`, set under the row's `config`):

| Value | Behaviour |
|---|---|
| `'all'` (default) | expand every row of every ID table; if a document's tables all have a single row, expand at least the first so system nodes are not empty |
| `'multi-row'` | only expand tables with more than one row (single-row illustrative tables produce no nodes — cleaner) |
| `false` | no automatic feature nodes; back to "directory structure only" |

**Known boundary**: if a `design.md` has **no table with an ID column** (the feature list is written as prose), that system's feature nodes still have to be added by hand with `design_ledger_update {parent_id, node_name}`, or you add an ID column to that table. The probe **reports honestly** which systems those are instead of pretending to pass.

### 4. The ledger records **actual development**, not the design checklist

Automatic generation only provides a **skeleton plus candidate entries**. **Whether a feature gets a node is decided by actual development**:

| Situation | What to do |
|---|---|
| A feature you are about to build, present in the design doc but with no node yet | `design_ledger_update {parent_id, node_name, status:"doing", mark:true}` — **create it** |
| Already in progress | `mark:true` + `status:"doing"` |
| Finished | `status:"done"` plus `code_refs` / `interfaces` |
| In the design doc, but not this round | **do not create it yet**; create it when you actually start |

Why: creating every design entry as an empty node up front turns the progress tree into a **mirror of the design document**, and the completion percentage gets diluted by entries that were never touched, hiding real progress. Creating nodes on demand keeps "the tree = what has actually been worked on", and it is **more general** — switching projects or document styles (prose / table / directory) changes nothing, because auto-generation is only a starting point.

This principle is written in three places so any inheriting session obeys it: the injection text in `lib/inject.js` (every session sees it), the `design_ledger_update` tool description, and section 2.1 of the bundled skill `skills/design-ledger/SKILL.md`.

## Relationship with AGENTS.md

```
AGENTS.md          ← injected natively by DSH (dsh-agent-instructions): project blurb + pointer to the ledger + current milestone
DEVPLAN/
  index.json       ← injected by this plugin: system-level index + completion
  systems/*.json   ← read on demand: node tables in detail
```

`AGENTS.md` has a **byte budget** (it gets truncated past it), so it carries only summary and pointers; ledger detail lives in `DEVPLAN/`. The two do not overlap: `AGENTS.md` is for humans, the ledger is for machines and injection.

## Installation

Install into the desktop profile (**use `plugin_manager`** — the desktop profile is owned by the Electron app, and `dsh plugin --profile desktop` is rejected by the CLI):

```
plugin_manager  install_bundle  target = link:E:\program\dsh\dsh-design-ledger
```

> - **With a `link:` install, every harness import must be routed by the launcher**, so this package's `peerDependencies` **must** declare every harness package it imports — currently **only `@deepseek-ai/dsh-tools`**. Conversely, **do not declare more than you import**: `cordis`, `dsh-system-prompt`, session and other harness packages are supplied by the DSH runtime and never resolved through npm, while DSH's compatibility check inspects every `@deepseek-ai/dsh*` peer — extra entries only add false negatives (e.g. `cordis` has no stable 4.x on npm at all, so declaring it is a constraint nothing can ever satisfy). For the same reason the plugin deliberately avoids schemastery — two scalar options are not worth a harness dependency.
> - After installing you **must restart the desktop client** for the bundle layer to activate (`fiberPhase` goes from `null` to `active`).
> - `plugin_manager` may report `application: failed` + `ambiguous-install`; this is a **false alarm** in practice (pnpm exited 0 and the on-disk state is correct). To judge success, look at `fiberPhase` via `plugin_manager list_plugins`, or check whether the tools appear.
> - The profile also keeps a `dsh.profile.bundles` list in its `package.json`. A bundle must be registered **there** as well, or it cannot activate. Any `plugin_manager` operation may rewrite that file and drop entries it did not create — so if the plugin "disappears by itself", check that list first.

## Installing from source (for other people)

```bash
git clone https://github.com/<owner>/dsh-design-ledger.git
# then, inside DSH:
#   plugin_manager  install_bundle  target = link:<absolute path of the clone>
#   add "dsh-design-ledger" to the profile's dsh.profile.bundles, then restart the client
```

There is no build step: the plugin is plain ESM `.js`, and the client half is loaded as a classic script.

> To **cut a new release** (tag, Release, tarball asset) see [RELEASING.md](RELEASING.md) — that is a maintainer
> workflow with nothing in it for users, so it does not live here.

## Verification status (measured on this machine)

> This table was re-checked after the plugin was actually run. Speculative rows ("⏳ waiting for client restart") were replaced with measured results, and the contracts that this round exposed — now fixed and guarded by regression probes — were added.

| Item | Status | Evidence |
|---|---|---|
| Unit tests | ✅ **13/13 pass** | `npm test` |
| Contract self-check (regression guard) | ✅ | `probe/contract-test.mjs`: injected text is a synchronous string, 6 tools register, 3 routes register, no throw with a missing/corrupt ledger |
| Panel data | ✅ | `probe/panel-list-test.mjs`: session workspace resolves correctly; deployment root / out-of-bounds / `node_modules` all 400 |
| Table-row tree build | ✅ | `probe/table-tree.mjs`: 5 feature tables / 16 rows detected on a real corpus, 2 ordinary tables correctly ignored |
| Plugin imports | ✅ | `node --check` + `probe/import-probe.mjs` (`name`/`inject`/`apply` present, `default === undefined`) |
| All 6 tools register | ✅ | host log `tools: built=6 ctx.tools=obj register=function` → `tools: registered=6/6` |
| `systemPrompt` section | ✅ | registered and produces text, **and no longer breaks the conversation** (crash 5) |
| **3 JSON routes** | ✅ | `GET status.json`, `GET list.json`, `POST bind.json`; host log `inject([webServer]) fired: register=function` → `routes registered=3` |
| Path safety (workspace boundary) | ✅ | `../../Windows`, `..%2F..%2FWindows`, `C:\Windows`, `/etc` all **403**; `resolveWs` accepts only the first confirmed workspace |
| Real design document end-to-end | ✅ | 14 `.md` / 153,957 characters / **≈92.7k tokens**; **4 systems** + **16 feature nodes** (table rows expanded), names taken from document H1 |
| Deep tree (system→subsystem→feature→subfeature) | ✅ | synthetic structure: `core gameplay → combat subsystem → hit detection / damage calc`; `S01_01_01_x` classified as `feature` |
| Node updates (status / code index / interfaces / bugs / mark) | ✅ | measured `acted = created … / status=doing / marked / codeRefs+=1 / interfaces+=1 / bug added …` |
| Focus injection refreshes across turns | ✅ | `mark:true` in one turn → next turn's context shows `聚焦：基地构筑与建筑运行 › 机枪塔` (with code index and interfaces) |
| Duplicate-bind protection | ✅ | existing ledger returns `409 ledger-exists` (progress is not overwritten) |
| **AGENTS.md integration** | ✅ | managed block is idempotent (byte-identical on rewrite); **never overwrites content outside the block**; inline references do not confuse boundary detection |
| Plugin **activates** in DSH | ✅ | `plugin_manager list_plugins` → `include:design-ledger` / `fiberPhase: active` |
| Sidebar entry + graphical picker | ✅ | sidebar "设计文档包含" works; the picker lists the session workspace and completes a binding |

### Graphical design-document picker

Clicking "Choose design document" in the sidebar panel opens a modal browser:

- breadcrumb navigation, "up", and "workspace root"
- directory rows show the **number of `.md` files in their subtree** (so you can spot the design-doc folder), and can be entered or selected directly
- `.md` rows show their size and can be selected
- selecting and pressing "Load as design document" issues `POST bind.json`; an existing ledger offers a "rebuild" path

**Security boundary**: all paths are validated **host-side** against the workspace (`safeJoin` + `isInside`), and absolute paths and `..` traversal are rejected outright; the panel cannot read anything outside the workspace.

## Tools

| Tool | Purpose |
|---|---|
| `design_ledger_status` | Current binding: design path, ledger location, statistics (nodes / completion / open bugs) |
| `design_ledger_init` | Bind a design document and generate the initial progress tree (or list candidates) |
| `design_ledger_read` | Read on demand: index / one system's subtree / one node's detail / bug list |
| `design_ledger_update` | Update a node: status, code index (file+symbol), interfaces, bugs, notes, focus mark |
| `design_doc_read` | Read design document text on demand (one file or one level, size-limited) |
| `design_doc_list` | List the design document tree with per-file sizes |

## Repository layout

```
dsh-design-ledger/
├── package.json                # DSH bundle manifest + dsh.client declaration + dsh.bundle.patch
├── cordis.patch.yml            # mount row (inserts this plugin into the profile config tree)
├── LICENSE                     # MIT
├── CHANGELOG.md                # changelog (from 0.1.0)
├── .gitattributes              # force LF in the repository (Windows development, avoids whole-file diffs)
├── .gitignore                  # ignores .design-ledger/ (plugin diagnostics) and DEVPLAN/state.json
├── README.md / README.en.md    # Chinese / English docs (section-by-section parallel)
├── RELEASING.md                # release process (maintainers only; users can ignore it)
├── lib/
│   ├── index.js                # host half: 6 tools + 3 panel routes + the injection section
│   ├── design-doc.js           # scanning, heading sections, table-row extraction (pure logic, unit-testable)
│   ├── ledger.js               # progress tree create/read/update + JSON shard storage (pure logic)
│   ├── inject.js               # layered injection text assembly
│   └── agents-md.js            # AGENTS.md managed block (idempotent, never touches content outside it)
├── client/
│   └── client.js               # browser half: sidebar entry + panel + picker
├── skills/
│   └── design-ledger/
│       └── SKILL.md            # bundled skill: how to build the ledger and keep it updated
├── .github/workflows/ci.yml    # CI: syntax + unit tests + docs check (zero-dependency; probes deliberately excluded)
├── test/                       # zero-dependency assertion tests (node --test, 13 cases)
└── probe/                      # repeatable self-check probes (contract / panel data / tree build)
    ├── register.mjs            # registers the resolve hook (pairs with resolve-hook.mjs)
    ├── contract-test.mjs       # ⭐ contracts: injected text must be a string / 6 tools / routes registered
    ├── panel-list-test.mjs     # ⭐ panel data: session workspace resolution + out-of-bounds rejection
    ├── table-tree.mjs          # ⭐ table rows → feature nodes (real design docs, read-only)
    ├── readme-check.mjs        # README health check: structure / fences / links (npm run check:readme)
    ├── client-ui-test.mjs      # client UI check: button contrast tokens / dictionary completeness / locale wiring (npm run check:client)
    ├── publish-audit.mjs       # publish audit: file-by-file comparison against GitHub (blob hashes) + privacy sweep (npm run audit)
    ├── reorder-crashes.mjs     # maintenance: reorder "Crash N" sections ascending (run before a release)
    ├── host-smoke.mjs          # host end-to-end (fake ctx, full flow)
    ├── route-test.mjs          # route behaviour and path safety
    ├── deep-tree.mjs           # multi-level directory tree (system→subsystem→feature→subfeature)
    ├── import-probe.mjs        # can it import; export shape
    └── resolve-hook.mjs        # resolver: points @deepseek-ai/* at DSH's dependency directory
```

> **The probes need to find DSH's dependency directory** (they reproduce DSH's module
> resolution under plain Node, so they need the real install location of `@deepseek-ai/*`).
> `probe/resolve-hook.mjs` **hardcodes no machine path**:
>
> 1. if `DSH_SHARED_NODE_MODULES` is set, it is **authoritative** (a wrong value fails loudly
>    instead of silently falling back);
> 2. otherwise it derives from `DSH_HOME` (default `~/.dsh`) and `DSH_PROFILE`, trying
>    `<home>/profiles/node_modules`, `<home>/profiles/<profile>/node_modules`, then
>    `<home>/profiles/desktop/node_modules`;
> 3. the acceptance test is "**this directory actually contains `@deepseek-ai/dsh-tools`**",
>    not "this directory exists" — on this machine both `profiles/desktop/node_modules` and
>    `profiles/node_modules` exist, but the harness packages only live in the latter.
>
> ```powershell
> # when you need to be explicit (PowerShell)
> $env:DSH_SHARED_NODE_MODULES = 'D:\AppData\.dsh\profiles\node_modules'
> ```
>
> Both auto-detection and an explicit value self-check, so **a wrong path produces an
> actionable error** rather than quietly degrading the probes into weaker checks.
> Note also: `lib/`, `client/` and `test/` contain no machine-specific paths, and `npm test`
> needs only Node (no DSH) — which is why CI runs only
> `npm run check` / `npm test` / `npm run check:readme`.

## License

MIT
