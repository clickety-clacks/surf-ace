# Surf Ace Extraction Patch -- Adversarial Review

**Date:** 2026-03-06
**Reviewer:** Claude Opus 4.6 (automated adversarial review)
**Scope:** Uncommitted changes in `/Users/mike/src/clawdbot` (provider repo)

---

## 1. What the Two Integration Commits Added

### Commit `0dd06c7d7` -- "Add surf-ace extension with surf-ace-markup skill"
- **Files:** 2 added
  - `extensions/surf-ace/openclaw.plugin.json` (plugin manifest)
  - `extensions/surf-ace/skills/surf-ace-markup/SKILL.md` (markup event handler skill)
- **Nature:** Purely additive. Created a standalone extension with a skill definition. No core code touched.

### Commit `ffec8bcb4` -- "Move surf_ace tools/runtime into clawline plugin"
- **Files:** 10 changed (165 insertions, 97 deletions)
  - **Moved:** `src/agents/tools/surf-ace-tools.ts` -> `extensions/clawline/src/surf-ace-tools.ts`
  - **Moved:** `src/agents/tools/surf-ace-tools.test.ts` -> `extensions/clawline/src/surf-ace-tools.test.ts`
  - **Created:** `extensions/clawline/src/surf-ace-runtime.ts` (52 lines, new module-scoped runtime holder)
  - **Deleted:** `src/clawline/surf-ace-runtime.ts` (old globalThis-based runtime sharing)
  - **Deleted:** `src/agents/tools/surf-ace-tools.runtime-sharing.test.ts`
  - **Modified:** `extensions/clawline/index.ts` (wired tool registration and runtime lifecycle)
  - **Modified:** `src/agents/openclaw-tools.ts` (removed surf ace tool imports and wiring)
  - **Modified:** `src/clawline/domain.ts` (added `getSurfAceRuntime()` to ProviderServer interface)
  - **Modified:** `src/clawline/server.ts` (removed `setClawlineSurfAceRuntime` calls, added `getSurfAceRuntime` to return object)
  - **Modified:** `src/clawline/service.ts` (added `getSurfAceRuntime` to ClawlineServiceHandle)

### Additional integration commits (chronological):
- `6b8e3261a` -- initial provider runtime and server integration
- `008326c08` -- agent tool definitions
- `7def04af2` -- tests
- `2e861a0b2` -- spec review alignment
- `29183c135` -- remove PIN pairing
- `d31e87c05` -- watch event routing to alerts
- `9d118537a` -- SQLite persistence and reconnect
- `0c374370e` -- globalThis runtime sharing
- `4a3217b23` -- expose runtime on service handle
- `e71f705bf` -- TXT record parsing fix
- `f8ac388a2` -- pair token field acceptance

---

## 2. What the Extraction Patch Removes

The extraction is an **uncommitted diff** in the clawdbot working tree, touching 6 files:

| File | Change |
|------|--------|
| `extensions/clawline/index.ts` | -6 lines: removes `setClawlineSurfAceRuntime` imports, `createSurfAceTools` registration, runtime lifecycle calls |
| `src/clawline/config.ts` | -4 lines: removes `surfAce` default config block |
| `src/clawline/domain.ts` | -6 lines: removes `SurfAceRuntime` import, `surfAce` config type, `getSurfAceRuntime()` from ProviderServer interface |
| `src/clawline/server.ts` | -89 lines: removes `createSurfAceManager` import, manager instantiation, HTTP event handler, system prompt injection, startup/shutdown lifecycle, callback host resolution |
| `src/clawline/service.ts` | -3 lines: removes `SurfAceRuntime` import, `getSurfAceRuntime` from ClawlineServiceHandle |
| `src/clawline/server.test.ts` | -2/+2 lines: renames test from "handles Surf Ace event callback endpoint" to "returns 404 for unknown callback routes", removes JSON body assertion |

### Key symbols removed from core interfaces:
- `ProviderConfig.surfAce` (config type)
- `ProviderServer.getSurfAceRuntime()` (interface method)
- `ClawlineServiceHandle.getSurfAceRuntime` (type member)
- `surfAceManager` (local variable in `createProviderServer`)
- `handleSurfAceEventHttpRequest` (HTTP handler function)
- `resolveSurfAceCallbackHost` (helper function)
- `surfAceManager.buildContextInjection` calls (system prompt enrichment)

---

## 3. What Remains Coupled -- Surf Ace References in Non-Surf-Ace Files

After the extraction patch is applied (working tree state):

### ZERO remaining Surf Ace references in core path files:
- `src/clawline/server.ts` -- clean
- `src/clawline/domain.ts` -- clean
- `src/clawline/service.ts` -- clean
- `src/clawline/config.ts` -- clean
- `extensions/clawline/index.ts` -- clean
- `src/agents/openclaw-tools.ts` -- clean (was cleaned in ffec8bcb4, remains clean)

### Surf Ace code that STILL EXISTS but is now orphaned:
- `src/clawline/surf-ace.ts` (1218 lines) -- core runtime, discovery, manager
- `src/clawline/surf-ace.test.ts` (12183 bytes) -- manager tests
- `src/clawline/surf-ace.discovery.test.ts` (1213 bytes) -- discovery tests
- `extensions/clawline/src/surf-ace-runtime.ts` (52 lines) -- runtime type/holder
- `extensions/clawline/src/surf-ace-tools.ts` (8052 bytes) -- tool definitions
- `extensions/clawline/src/surf-ace-tools.test.ts` (3463 bytes) -- tool tests
- `extensions/surf-ace/openclaw.plugin.json` -- plugin manifest
- `extensions/surf-ace/skills/surf-ace-markup/SKILL.md` -- markup skill

### Test file residual:
- `src/clawline/server.test.ts` line 1343: still uses the URL `/surf-ace/events/a1b2c3d4` in a test that now asserts generic 404 behavior. This is acceptable but leaves a Surf Ace URL literal in the test.

---

## 4. Verdict on the Extraction

**VERDICT: CLEAN with minor observations.**

The extraction is well-executed. It removes exactly the coupling points between the Surf Ace subsystem and the core provider path:

1. **Config decoupled** -- `surfAce` config block removed from defaults and type
2. **Interface decoupled** -- `getSurfAceRuntime()` removed from both `ProviderServer` and `ClawlineServiceHandle`
3. **Server runtime decoupled** -- manager creation, startup, shutdown, HTTP handler, and system prompt injection all removed
4. **Extension plugin decoupled** -- tool registration and runtime lifecycle removed from `index.ts`
5. **No accidental removals** -- all non-Surf-Ace code remains intact; alert endpoint, WS handler, session router, pairing flow, auth, media pipeline, terminal sessions are all untouched
6. **Test adapted correctly** -- the surf ace event endpoint test is repurposed as a generic 404 test

### System prompt behavior change:
The extraction changes system prompt behavior. Previously, the system prompt was:
```
[adapter system prompt] + "\n\n" + [surfAceContext]
```
Now it is simply:
```
adapter system prompt
```
This is the correct behavior when Surf Ace is removed. The `surfAceContext` was injected to inform the agent about available screens.

---

## 5. Specific Risks and Gaps

### RISK 1 (LOW) -- Orphaned Surf Ace source files not deleted
- **Files:** `src/clawline/surf-ace.ts`, `src/clawline/surf-ace.test.ts`, `src/clawline/surf-ace.discovery.test.ts`, `extensions/clawline/src/surf-ace-runtime.ts`, `extensions/clawline/src/surf-ace-tools.ts`, `extensions/clawline/src/surf-ace-tools.test.ts`, `extensions/surf-ace/`
- **Impact:** These files compile and their tests still run. They are dead code from the server's perspective. No runtime impact, but test runner still executes them (including the manager tests that exercise the full surf ace runtime).
- **Recommendation:** Either delete these files as part of the extraction, or explicitly exclude them from the test runner. Keeping them is defensible if they're intended for a future re-integration, but they add noise.

### RISK 2 (LOW) -- Test uses Surf Ace URL literal
- **File:** `src/clawline/server.test.ts` line 1343
- **Detail:** The renamed test "returns 404 for unknown callback routes" still POSTs to `/surf-ace/events/a1b2c3d4`. Functionally correct (it does get a 404), but the URL is semantically tied to Surf Ace.
- **Recommendation:** Consider using a truly generic unknown route like `/unknown/callback/path` to fully decouple the test.

### RISK 3 (NONE) -- Clawline client repo (iOS)
- **State:** The iOS client repo (`/Users/mike/src/clawline`) has orphaned Surf Ace scaffold files on `main`:
  - `ios/Clawline/Surf Ace/ContentView.swift` (template "Hello, world!")
  - `ios/Clawline/Surf Ace/Surf_AceApp.swift` (template app entry)
  - `ios/Clawline/Surf AceTests/` and `ios/Clawline/Surf AceUITests/`
- These are NOT in the Xcode project (`project.pbxproj` has zero Surf Ace references on `main`). They are tree-only orphans from the initial Xcode target creation.
- The fully developed SurfAce iOS app exists only on the `clawline-surface-ios` branch (never merged to main).
- **Impact:** Zero. These files don't compile and aren't wired into anything.

### RISK 4 (NONE) -- Electron surface
- The electron surface code exists only on the `clawline-surface-electron` branch (never merged to main).
- **Impact:** Zero. Completely isolated.

### RISK 5 (NONE) -- Plugin-SDK exports
- `src/plugin-sdk/index.ts` has zero Surf Ace references.
- The B13 invariant (`ClawlineServiceHandle` export) is preserved minus the `getSurfAceRuntime` method.
- **Impact:** Any code that previously called `handle.getSurfAceRuntime()` will get a TypeScript compile error, which is the correct failure mode for removed functionality.

### RISK 6 (INFORMATIONAL) -- B4 invariant violation
- The rebase spec context (`clawline-rebase-spec-context.md`) lists **B4 -- Surf Ace integration** as a behavior that "MUST survive the merge."
- This extraction deliberately violates B4 by removing Surf Ace from the live provider path.
- **Recommendation:** Update the rebase spec context to remove or mark B4 as intentionally deferred. Otherwise a future merge agent may attempt to re-introduce Surf Ace coupling.

---

## Summary

The extraction patch is **clean and safe to commit**. It surgically removes all Surf Ace coupling from the provider's runtime path (6 files, 109 deletions) without affecting any non-Surf-Ace behavior. The only actionable items are:
1. Decide whether to delete the orphaned Surf Ace source files or keep them for future use
2. Update the B4 invariant in the rebase spec context
3. Optionally clean up the test URL literal
