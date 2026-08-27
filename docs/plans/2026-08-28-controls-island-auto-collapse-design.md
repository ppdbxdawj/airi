# Controls Island Auto-Collapse Design

Date: 2026-08-28

Status: Approved for implementation. The implementation plan was revised after repository test-rule review.

Issue: [moeru-ai/airi#1939](https://github.com/moeru-ai/airi/issues/1939)

## Context

The expanded controls island uses `useElectronMouseInElement` in `apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/index.vue`.

That composable updates `isOutside` from several sources. Electron mouse samples, `ResizeObserver`, `MutationObserver`, window events, and document leave events all call the same update function.

The controls island treats every `isOutside` change as a mouse transition. It then uses both `refDebounced` and `useIntervalFn` to collapse the panel. The adaptive island layout changes the element size and position during expansion and relocation. Those layout updates can therefore look like a real mouse leave.

The shared composable also serves page-level fade-on-hover and click-through behavior. This fix does not change that composable, screen-to-window coordinate conversion, or Electron click-through state.

## Goals

- Keep the panel open while the pointer stays inside the current island bounds.
- Start one cancelable 1500 ms collapse timer at the first real relative-pointer move outside the island.
- Keep the original deadline when later pointer samples remain outside.
- Cancel the timer when the pointer returns, the panel collapses, the component scope ends, or a blocking overlay opens.
- Re-check the expanded state, overlay state, pointer position, and current island bounds when the timer fires.
- Keep hearing and profile overlays open while they block interaction.
- Re-evaluate the pointer when a blocking overlay closes. If the pointer remains outside, start a new full 1500 ms delay. If it is inside, keep the panel open.

## Non-goals

- Do not change `useElectronMouseInElement` or any shared mouse stream.
- Do not change the Electron relative-coordinate calculation.
- Do not change `apps/stage-tamagotchi/src/renderer/pages/index.vue` click-through handling.
- Do not add a new pointer event path that can change transparent-window or click-through behavior.
- Do not change the adaptive island layout or its UnoCSS classes.
- Do not mock Vue, Pinia, or Vue components in the regression test.

## Production boundary

Add `apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/use-controls-island-auto-collapse.ts` as a local deep module. The module owns the collapse policy and timer lifecycle. It is a real production boundary used by `index.vue`, not a test-only export.

The module accepts the expanded state, blocking state, relative pointer coordinates, live element geometry, and an `onCollapse` callback. It does not import Pinia, child components, or Electron services. `index.vue` passes the refs returned by `useElectronMouseInElement` and keeps responsibility for the overlay set and the existing `interactionChange` event.

The module owns one timeout handle. It watches only the relative pointer `x` and `y` values and the expanded/blocked state. It does not watch the mixed `isOutside` value or the element geometry. Geometry changes remain available to the final predicate through live refs.

The expanded-state watcher never schedules a timeout for a collapsed-to-expanded transition. It only clears the timeout while the panel is closed or blocked. The sole no-pointer-move recovery path is a blocked-to-unblocked transition while the panel was already expanded.

## Timer behavior

The module calculates local pointer coordinates from the relative pointer and current element position. It uses the current composable edge rules: zero width or height is outside, and a pointer is outside when either local coordinate is less than zero or greater than the corresponding size.

On a pointer sample, the module cancels the timeout when the panel is closed, an overlay blocks interaction, or the pointer is inside. When the pointer is outside and no timeout exists, it starts one 1500 ms timeout. A later outside sample does not cancel or replace an existing timeout, so the deadline remains anchored to the first outside sample.

The timeout callback clears its handle before it runs the final predicate. It collapses only when the panel is still expanded, no blocking overlay is open, and the current pointer is outside the current bounds. A bounds-only change can therefore prevent collapse at callback time without starting a new timer.

When the blocking state changes from blocked to unblocked, the module evaluates the current pointer. It starts a new full delay only when the panel was already expanded and the pointer is outside. A collapsed-to-expanded transition only clears or preserves an empty timeout, even when the current geometry says outside. Opening either overlay cancels the current timeout. The `effectScope` cleanup path clears the timeout when the component scope ends.

## Controls island integration

Remove the `refDebounced` and `useIntervalFn` imports and their collapse logic from `index.vue`. Keep the existing overlay set, `defineExpose` properties, interaction event, child components, and template layout unchanged.

The existing watcher that emits `interactionChange` can remain. The watcher that clears overlay state when the panel closes can remain. The new module owns timer cancellation, so `index.vue` must not add another timer or another outside watcher.

## State transitions

| State or event | Action |
| --- | --- |
| Panel opens from collapsed state | Keep the timeout canceled. Do not schedule from current pointer or geometry. |
| First relative pointer sample outside | Start the 1500 ms timer. |
| Later relative pointer samples outside | Keep the existing timer and deadline. |
| Relative pointer sample inside | Cancel the collapse timeout. |
| Island layout or size changes | Refresh bounds through the existing composable. Do not start or reset a timer. |
| Mixed `isOutside` signal changes alone | Ignore the signal for collapse scheduling. |
| Blocking overlay opens | Cancel the timeout and keep the panel open. |
| One overlay closes while another remains open | Keep the timeout canceled and keep the panel open. |
| All overlays close while the pointer remains outside | Start a new full 1500 ms delay. |
| Panel closes manually | Cancel the timeout and clear overlay state as before. |
| Timeout fires | Re-check all state and current bounds, then collapse only when still outside. |
| Component scope ends | Cancel the timeout. |

## Testing design

Add `apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/use-controls-island-auto-collapse.test.ts` beside the production module. Test the module through its production API with real Vue `ref`, `computed`, `watch`, `nextTick`, and `effectScope` behavior. Use Vitest fake timers.

The test does not mock Vue, Pinia, components, Electron IPC, or the shared Electron composable. The module receives the same pointer and geometry refs that `index.vue` passes in production. This boundary keeps the test small and avoids prohibited component mocks while still testing the timer policy used by the application.

The test will cover these observable cases:

- A collapsed-to-expanded transition does not start a timer, even when the current pointer and geometry say outside.
- Geometry-only changes and an independent mixed `isOutside` ref change do not start a timer.
- After that transition, a one-pixel relative `x` or `y` change that remains outside starts a timer.
- The first real outside coordinate change starts a timer.
- The panel stays open at 1499 ms and collapses at 1500 ms.
- Further outside coordinate samples do not move the original deadline.
- A re-entry before the deadline cancels the timer.
- A bounds change before the deadline is read by the callback, so a pointer that is now inside does not collapse the panel.
- Hearing and profile overlay refs combine into a blocking computed state. Opening either one cancels the timer. Closing one while the other remains open does not restart it. Closing both while still outside starts a new full delay.
- Manual collapse and `effectScope.stop()` clear the timer.

The first test is written before the new module exists. Its expected initial failure is an import-resolution failure because it defines the approved production boundary before implementation. This is an accepted test-first scaffold: testing the old component directly would require mocking child Vue components or Pinia, which the repository Vitest rules prohibit. After the module exists, the same test proves the old mixed-signal behavior is absent from the new boundary. The final integration is verified by the unchanged real component wiring, typecheck, and Electron validation.

Put the issue URL in a comment directly above the first regression test:

```ts
// https://github.com/moeru-ai/airi/issues/1939
```

## Verification

Use the `node` project declared in `apps/stage-tamagotchi/vitest.config.ts`. The targeted command must run from the package filter and use the app-relative test path:

```bash
pnpm -F @proj-airi/stage-tamagotchi exec vitest run --project node src/renderer/components/stage-islands/controls-island/use-controls-island-auto-collapse.test.ts
```

Run the stage-tamagotchi lint and typecheck commands. Run the repository lint and typecheck commands required by `AGENTS.md` when targeted checks pass.

For Electron validation, start the app with `APP_REMOTE_DEBUG=true` and a task-specific `APP_REMOTE_DEBUG_PORT`. Use raw `/json/list` target discovery before `agent-browser` interaction. Expand the controls island, keep the pointer inside the panel during its layout transition, and verify that it stays open. Move the pointer outside, wait past 1500 ms, and verify that it closes. Repeat with hearing and profile overlays. Record any unverified platform result for Linux, macOS, or Windows.
