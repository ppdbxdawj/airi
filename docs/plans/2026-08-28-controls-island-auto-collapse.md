# Controls Island Auto-Collapse Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the expanded Electron controls island collapse only after a real relative-pointer leave, while preserving overlay and click-through behavior.

**Architecture:** Add a local `use-controls-island-auto-collapse.ts` composable that owns the timer policy and cleanup. Pass it real Vue refs from the controls island. Ignore the shared composable's mixed `isOutside` signal for collapse scheduling, and use one timer anchored to the first outside sample. A collapsed-to-expanded transition never schedules from the current geometry; blocked-to-unblocked recovery is the only no-pointer-move schedule path.

**Tech Stack:** Vue 3 Composition API, TypeScript, Electron, VueUse, Vitest, jsdom, UnoCSS.

---

## Task 1: Add the test-first production-boundary scaffold

**Files:**
- Create: `apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/use-controls-island-auto-collapse.test.ts`
- Reference: `.agents/skills/enforce-rules-for-vitest/SKILL.md`

**Step 1: Define test refs without mocks**

Add `// @vitest-environment jsdom`. Import `computed`, `effectScope`, `nextTick`, and `ref` from Vue. Import Vitest fake-timer helpers. Do not use `vi.mock`, component stubs, Pinia mocks, or Electron service mocks.

Create refs for expanded state, hearing state, profile state, relative pointer coordinates, and element geometry. Create `blocked = computed(() => hearingOpen.value || profileOpen.value)`. Pass an `onCollapse` spy to the planned composable boundary. Start the test with the pointer and geometry outside, then set `expanded` from false to true.

**Step 2: Write the smallest Issue #1939 regression test**

Keep the pointer and geometry outside while `expanded` is false. Set `expanded` to true and await `nextTick()`. Change only the geometry refs and an independent `mixedIsOutside` ref to represent the layout-observer update that the old component treats as a leave. Advance fake timers by 1500 ms. Assert that `onCollapse` was not called and that no timer was created. Then change `x` by one pixel while it remains outside, await `nextTick()`, and assert that one timer is created.

Put the issue URL directly above this test:

```ts
// https://github.com/moeru-ai/airi/issues/1939
```

**Step 3: Run the test before creating the production module**

First confirm the app project selector:

```bash
pnpm -F @proj-airi/stage-tamagotchi exec vitest --help
```

Then run the new test with the actual project name from `apps/stage-tamagotchi/vitest.config.ts`:

```bash
pnpm -F @proj-airi/stage-tamagotchi exec vitest run --project node src/renderer/components/stage-islands/controls-island/use-controls-island-auto-collapse.test.ts
```

Expected: Vitest fails at import resolution because `use-controls-island-auto-collapse.ts` does not exist yet. This is an accepted test-first scaffold. A direct old-component reproduction would require prohibited Vue component or Pinia mocks; the shared Electron boundary is intentionally not changed to create a test seam.

## Task 2: Implement the local auto-collapse module

**Files:**
- Create: `apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/use-controls-island-auto-collapse.ts`
- Reference: `packages/electron-vueuse/src/composables/use-electron-mouse-in-element.ts:38-68`

**Step 1: Define the production options boundary**

Define an exported options type only when the public module signature needs it. Accept readonly Vue refs for `expanded`, `blocked`, relative pointer `x` and `y`, element position, element width, element height, and an `onCollapse` callback. Keep the module independent from Pinia, child components, and Electron IPC.

**Step 2: Add the current-bounds predicate**

Compute local pointer coordinates from relative pointer coordinates and current element position. Return outside for zero width or height, or when either local coordinate is less than zero or greater than the corresponding size. Use the same edge rules as `useElectronMouseInElement`.

**Step 3: Add one cancelable timeout**

Keep one `ReturnType<typeof setTimeout> | undefined` handle and one private cancellation function. Use a local 1500 ms delay. Register cancellation with `onScopeDispose` so the component scope owns the timer lifecycle.

**Step 4: Schedule at the first outside sample**

Use one watcher over `[expanded, blocked, x, y]` so a coordinate change is interpreted with the expanded and blocking state from the same Vue flush. Cancel the timeout when the panel is closed, an overlay blocks interaction, or the current pointer is inside. When the panel was already expanded, the pointer coordinates changed, the pointer is outside, and no timeout exists, create one. Do not cancel or replace an existing timeout when another outside sample arrives. Do not schedule from the expanded false-to-true transition, including a same-flush coordinate update.

**Step 5: Re-check current state at callback time**

Clear the timeout handle at callback entry. Call `onCollapse` only when the panel is still expanded, no overlay blocks interaction, and the current-bounds predicate is outside. Read all geometry refs inside the callback.

**Step 6: Handle expansion and overlay transitions**

Handle the expanded and blocking transitions in the same `[expanded, blocked, x, y]` watcher. Cancel when the panel is closed or blocked. Keep the timer canceled during the expanded false-to-true transition, even when the current pointer is outside. When the panel was already expanded and the blocking state changes from true to false, schedule a new full delay only when the pointer is currently outside, even if no pointer moved. This makes overlay close behavior explicit and prevents one overlay from reopening the timer while another remains open.

## Task 3: Make the test pass and add all timer cases

**Files:**
- Modify: `apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/use-controls-island-auto-collapse.test.ts`
- Reference: `apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/use-controls-island-auto-collapse.ts`

**Step 1: Run the initial regression test**

Run:

```bash
pnpm -F @proj-airi/stage-tamagotchi exec vitest run --project node src/renderer/components/stage-islands/controls-island/use-controls-island-auto-collapse.test.ts
```

Expected: the geometry and mixed-signal regression passes, with no timer created.

**Step 2: Test the collapsed-to-expanded guard**

Keep the pointer and geometry outside while `expanded` is false. Set `expanded` to true and await `nextTick()`. Assert that no timer exists. Change the relative `x` coordinate by one pixel while it remains outside. Await `nextTick()` and assert that exactly one timer exists.

**Step 3: Test the first real outside sample**

Start inside. Change `x` or `y` to an outside coordinate and await `nextTick()`. Assert that one timer exists and that `onCollapse` is not called before the delay.

**Step 4: Test the exact 1499 ms and 1500 ms boundary**

Advance fake timers by 1499 ms and assert that `onCollapse` was not called. Advance one more millisecond and assert that it was called once.

**Step 5: Test continuous outside samples**

Start the timer at time zero. Advance 500 ms. Change the outside coordinate again and await `nextTick()`. Advance 999 ms and assert that no collapse occurred. Advance one millisecond and assert one collapse. This proves that later outside samples do not move the original deadline.

**Step 6: Test re-entry cancellation**

Start an outside timer. Change the pointer back inside before the deadline and await `nextTick()`. Assert that the timer is cleared. Advance the remaining fake time and assert that the panel does not collapse.

**Step 7: Test the latest bounds at callback time**

Start an outside timer. Change only the width or position refs so that the unchanged pointer becomes inside. Await any Vue flush needed for the ref update. Advance to 1500 ms and assert that the callback does not collapse the panel.

**Step 8: Test independent hearing and profile blocking state**

Start an outside timer. Set `hearingOpen` to true and assert that the timer is canceled. Keep hearing open, set `profileOpen` to true, then close hearing. Assert that the timer remains canceled because profile remains open. Close profile while the pointer remains outside. Assert that a new timer starts and that collapse occurs only after a fresh 1500 ms.

Repeat the same assertions with profile opened first when needed to keep both overlay paths explicit.

**Step 9: Test manual collapse and scope cleanup**

Start an outside timer, set `expanded` to false, and advance fake timers. Assert that `onCollapse` is not called. In a second `effectScope`, start a timer, call `scope.stop()`, assert that the timer count returns to zero, and advance fake timers without a callback.

## Task 4: Wire the module into the controls island

**Files:**
- Modify: `apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/index.vue:1-115`
- Reference: `packages/electron-vueuse/src/composables/use-electron-mouse-in-element.ts:38-68`
- Reference: `.agents/skills/enforce-rules-for-unocss/SKILL.md`

**Step 1: Read the live coordinate and geometry refs**

Destructure `x`, `y`, `elementPositionX`, `elementPositionY`, `elementWidth`, and `elementHeight` from `useElectronMouseInElement(islandElement)`. Keep the call site unchanged so the shared Electron coordinate conversion and observer lifecycle remain intact.

**Step 2: Invoke the production auto-collapse module**

Pass `expanded`, `isBlocked`, the six pointer and geometry refs, and an `onCollapse` callback that sets `expanded.value = false`. Let the module own the timer and scope cleanup.

**Step 3: Preserve existing overlay and interaction state**

Keep `blockingOverlays`, `isBlocked`, `setOverlay`, `defineExpose`, the overlay-clearing watcher, and the `interactionChange` watcher. Do not add timer cancellation logic to these watchers because the module already watches the reactive expanded and blocked state.

**Step 4: Remove the competing mechanisms**

Remove the `refDebounced` and `useIntervalFn` imports, the debounced `isOutside` watcher, and the interval loop. Do not modify template classes, child components, `useElectronMouseInElement`, or page-level click-through code.

## Task 5: Run targeted tests and repository checks

**Files:**
- Reference: `apps/stage-tamagotchi/vitest.config.ts`
- Reference: `apps/stage-tamagotchi/package.json`
- Reference: `AGENTS.md`

**Step 1: Run the focused auto-collapse test**

Run:

```bash
pnpm -F @proj-airi/stage-tamagotchi exec vitest run --project node src/renderer/components/stage-islands/controls-island/use-controls-island-auto-collapse.test.ts
```

Expected: all Issue #1939 timer, geometry, overlay, and cleanup cases pass.

**Step 2: Run all controls-island Node tests**

Run:

```bash
pnpm -F @proj-airi/stage-tamagotchi exec vitest run --project node src/renderer/components/stage-islands/controls-island
```

Expected: the placement and existing controls-island tests pass.

**Step 3: Run the stage-tamagotchi typecheck**

Run:

```bash
pnpm -F @proj-airi/stage-tamagotchi typecheck
```

Expected: Vue and TypeScript checks pass.

**Step 4: Run the stage-tamagotchi lint**

Run:

```bash
pnpm -F @proj-airi/stage-tamagotchi lint
```

Expected: lint passes without changes to unrelated files.

**Step 5: Run the required repository checks**

Run:

```bash
pnpm lint
pnpm typecheck
```

Expected: the repository checks pass, or the final report lists unrelated baseline failures with their output.

Do not create commits during implementation. Do not push or create a pull request.

## Task 6: Perform Electron validation when the local runtime is available

**Files:**
- Reference: `.agents/skills/agent-browser/SKILL.md`
- Reference: `.agents/skills/agent-browser-electron/SKILL.md`
- Reference: `apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/index.vue`

**Step 1: Start the Electron app with a task-specific CDP port**

Run:

```bash
APP_REMOTE_DEBUG=true APP_REMOTE_DEBUG_PORT=9250 pnpm dev:tamagotchi
```

Use another free port if `9250` is in use.

**Step 2: Discover the renderer target**

Run:

```bash
curl -sS http://127.0.0.1:9250/json/list
agent-browser --cdp 9250 tab
```

Select the renderer target by route and verify it with `get url`, `get title`, and `snapshot -i`. Do not infer the target from a positional tab number.

**Step 3: Verify the expanded panel path**

Expand the controls island. Keep the pointer inside the expanded panel while its DOM size changes. Confirm that it remains open beyond 1500 ms. Move the pointer outside and confirm that it closes after the delay.

**Step 4: Verify blocking overlays**

Open hearing and profile overlays while the pointer is outside. Confirm that neither overlay causes the panel to collapse. Keep one overlay open while closing the other. Close the last overlay and confirm that an outside pointer starts a fresh delay.

**Step 5: Record platform limits**

Report which platform and Electron window path were tested. Report Linux, macOS, or Windows behavior that was not available locally. Do not change shared coordinate or click-through code to compensate for an unavailable platform.

No implementation commit is required by this plan. Leave the worktree changes uncommitted for parent review.
