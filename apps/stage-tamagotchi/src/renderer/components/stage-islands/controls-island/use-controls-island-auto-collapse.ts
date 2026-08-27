import type { Ref } from 'vue'

import { onScopeDispose, watch } from 'vue'

/** Delay used after the first outside pointer sample before auto-collapse. */
const AUTO_COLLAPSE_DELAY_MS = 1500

/**
 * Reactive inputs for the controls island auto-collapse policy.
 *
 * The pointer and bounds refs come from the same Electron mouse-in-element
 * instance. The policy owns one timer, keeps its first-outside deadline, and
 * releases that timer with the Vue effect scope.
 */
export interface UseControlsIslandAutoCollapseOptions {
  /** True while a hearing or profile overlay blocks interaction and collapse. */
  blocked: Readonly<Ref<boolean>>
  /** Current island height in renderer-coordinate pixels; zero is outside. */
  elementHeight: Readonly<Ref<number>>
  /** Current island left edge in renderer-coordinate pixels. */
  elementPositionX: Readonly<Ref<number>>
  /** Current island top edge in renderer-coordinate pixels. */
  elementPositionY: Readonly<Ref<number>>
  /** Current island width in renderer-coordinate pixels; zero is outside. */
  elementWidth: Readonly<Ref<number>>
  /** Whether the panel is expanded; opening it never schedules a timer. */
  expanded: Readonly<Ref<boolean>>
  /** Called after 1500 ms when the panel remains expanded and outside. */
  onCollapse: () => void
  /** Current Electron relative pointer x coordinate in renderer pixels. */
  x: Readonly<Ref<number>>
  /** Current Electron relative pointer y coordinate in renderer pixels. */
  y: Readonly<Ref<number>>
}

/**
 * Collapse an expanded controls island after a real relative-pointer leave.
 *
 * A changed pointer coordinate starts one cancelable 1500 ms timer only when
 * the panel was already expanded and unblocked. Later outside samples keep the
 * original deadline. The callback reads current bounds and state, and scope
 * disposal clears the timer before the owning component is destroyed.
 */
export function useControlsIslandAutoCollapse(options: UseControlsIslandAutoCollapseOptions): void {
  let collapseTimer: ReturnType<typeof setTimeout> | undefined

  function cancelCollapse() {
    if (collapseTimer === undefined)
      return

    clearTimeout(collapseTimer)
    collapseTimer = undefined
  }

  function isPointerOutside() {
    const localX = options.x.value - options.elementPositionX.value
    const localY = options.y.value - options.elementPositionY.value
    const width = options.elementWidth.value
    const height = options.elementHeight.value

    return width === 0 || height === 0 || localX < 0 || localY < 0 || localX > width || localY > height
  }

  function scheduleCollapse() {
    if (!options.expanded.value || options.blocked.value || !isPointerOutside()) {
      cancelCollapse()
      return
    }

    if (collapseTimer !== undefined)
      return

    collapseTimer = setTimeout(() => {
      collapseTimer = undefined

      if (options.expanded.value && !options.blocked.value && isPointerOutside())
        options.onCollapse()
    }, AUTO_COLLAPSE_DELAY_MS)
  }

  watch([options.expanded, options.blocked, options.x, options.y], ([expanded, blocked, x, y], previousState) => {
    if (!expanded || blocked) {
      cancelCollapse()
      return
    }

    if (previousState === undefined)
      return

    const [previousExpanded, previousBlocked, previousX, previousY] = previousState
    const pointerMoved = x !== previousX || y !== previousY
    if (previousExpanded === true && previousBlocked === true)
      scheduleCollapse()
    else if (previousExpanded === true && previousBlocked === false && pointerMoved)
      scheduleCollapse()
  }, { immediate: true })

  onScopeDispose(cancelCollapse)
}
