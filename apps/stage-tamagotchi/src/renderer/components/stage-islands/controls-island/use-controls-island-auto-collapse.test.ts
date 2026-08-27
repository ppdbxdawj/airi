// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, ref } from 'vue'

import { useControlsIslandAutoCollapse } from './use-controls-island-auto-collapse'

describe('useControlsIslandAutoCollapse', () => {
  const expanded = ref(false)
  const hearingOpen = ref(false)
  const profileOpen = ref(false)
  const pointerX = ref(200)
  const pointerY = ref(50)
  const elementPositionX = ref(0)
  const elementPositionY = ref(0)
  const elementWidth = ref(100)
  const elementHeight = ref(100)
  const onCollapse = vi.fn()
  const blocked = computed(() => hearingOpen.value || profileOpen.value)
  let scope: ReturnType<typeof effectScope>

  function installAutoCollapse() {
    scope = effectScope()
    scope.run(() => {
      useControlsIslandAutoCollapse({
        blocked,
        elementHeight,
        elementPositionX,
        elementPositionY,
        elementWidth,
        expanded,
        onCollapse,
        x: pointerX,
        y: pointerY,
      })
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    expanded.value = false
    hearingOpen.value = false
    profileOpen.value = false
    pointerX.value = 200
    pointerY.value = 50
    elementPositionX.value = 0
    elementPositionY.value = 0
    elementWidth.value = 100
    elementHeight.value = 100
    onCollapse.mockReset()

    installAutoCollapse()
  })

  afterEach(() => {
    scope.stop()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  // ROOT CAUSE:
  //
  // The old debounce and interval both consumed the shared `isOutside` signal.
  // Geometry observer updates could therefore collapse the panel without a pointer move.
  //
  // This policy no longer consumes the shared mixed `isOutside` signal.
  // It watches relative pointer coordinates and reads current bounds only when needed.
  // https://github.com/moeru-ai/airi/issues/1939
  it('regression: Issue #1939 ignores stale coordinates and bounds-only updates, then reacts to a real outside move', async () => {
    expanded.value = true
    await nextTick()

    expect(vi.getTimerCount()).toBe(0)

    elementPositionX.value = 1
    elementPositionY.value = 1
    elementWidth.value = 120
    elementHeight.value = 120
    await nextTick()

    expect(vi.getTimerCount()).toBe(0)

    pointerX.value = 201
    await nextTick()

    expect(vi.getTimerCount()).toBe(1)
  })

  it('does not treat a same-tick expansion update as a pointer leave', async () => {
    expanded.value = true
    pointerX.value = 201
    await nextTick()

    expect(vi.getTimerCount()).toBe(0)

    pointerX.value = 202
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('starts a timer only when an expanded panel receives its first real outside move', async () => {
    pointerX.value = 50
    expanded.value = true
    await nextTick()

    expect(vi.getTimerCount()).toBe(0)

    pointerX.value = 200
    await nextTick()

    expect(vi.getTimerCount()).toBe(1)
    expect(onCollapse).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1499)
    expect(onCollapse).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onCollapse).toHaveBeenCalledOnce()
  })

  it('keeps the original deadline when outside samples continue', async () => {
    pointerX.value = 50
    expanded.value = true
    await nextTick()

    pointerX.value = 200
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(500)
    pointerX.value = 201
    await nextTick()

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(999)
    expect(onCollapse).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onCollapse).toHaveBeenCalledOnce()
  })

  it('cancels the timer when the pointer re-enters the current bounds', async () => {
    pointerX.value = 50
    expanded.value = true
    await nextTick()

    pointerX.value = 200
    await nextTick()
    vi.advanceTimersByTime(500)

    pointerX.value = 50
    await nextTick()

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(onCollapse).not.toHaveBeenCalled()
  })

  it('rechecks the latest bounds when the timer reaches its deadline', async () => {
    expanded.value = true
    await nextTick()

    pointerX.value = 201
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)

    elementWidth.value = 300
    await nextTick()
    vi.advanceTimersByTime(1500)

    expect(onCollapse).not.toHaveBeenCalled()
  })

  it('cancels while hearing or profile overlays block the panel and restarts once', async () => {
    expanded.value = true
    await nextTick()

    pointerX.value = 201
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)

    hearingOpen.value = true
    await nextTick()
    expect(vi.getTimerCount()).toBe(0)

    profileOpen.value = true
    hearingOpen.value = false
    await nextTick()
    expect(vi.getTimerCount()).toBe(0)

    profileOpen.value = false
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(1499)
    expect(onCollapse).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onCollapse).toHaveBeenCalledOnce()
  })

  it('keeps the timer blocked when profile closes before hearing', async () => {
    expanded.value = true
    await nextTick()

    pointerX.value = 201
    await nextTick()
    profileOpen.value = true
    await nextTick()
    expect(vi.getTimerCount()).toBe(0)

    hearingOpen.value = true
    profileOpen.value = false
    await nextTick()
    expect(vi.getTimerCount()).toBe(0)

    hearingOpen.value = false
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('cancels on manual collapse and when its effect scope is disposed', async () => {
    expanded.value = true
    await nextTick()

    pointerX.value = 201
    await nextTick()
    expanded.value = false
    await nextTick()

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1500)
    expect(onCollapse).not.toHaveBeenCalled()

    expanded.value = true
    await nextTick()
    pointerX.value = 202
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)

    scope.stop()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1500)
    expect(onCollapse).not.toHaveBeenCalled()
  })
})
