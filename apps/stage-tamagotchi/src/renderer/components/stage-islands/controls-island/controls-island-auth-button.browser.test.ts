import { useAuthStore } from '@proj-airi/stage-ui/stores/auth'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { nextTick } from 'vue'

import ControlsIslandAuthButton from './controls-island-auth-button.vue'

import {
  electronAuthAttemptSettled,
  electronAuthCallback,
  electronAuthCallbackError,
} from '../../../../shared/eventa'

interface EventDefinition {
  id?: string
  sendEvent?: { id: string }
}

type ContextHandler = (payload?: unknown) => void

const electronMocks = vi.hoisted(() => ({
  contextHandlers: new Map<string, ContextHandler>(),
  openSettings: vi.fn(),
  startSigningIn: vi.fn(),
}))

const authBoundaryMocks = vi.hoisted(() => ({
  getFlux: vi.fn(),
  requestAuthSession: vi.fn(),
  triggerSignIn: vi.fn(),
}))

vi.mock('@proj-airi/stage-ui/composables/api', () => ({
  client: {
    api: {
      v1: {
        flux: {
          $get: authBoundaryMocks.getFlux,
        },
      },
    },
  },
}))

vi.mock('@proj-airi/stage-ui/libs/auth', () => ({
  triggerSignIn: authBoundaryMocks.triggerSignIn,
}))

vi.mock('@proj-airi/stage-ui/libs/auth-client', () => ({
  authClient: {
    getSession: vi.fn(),
    listSessions: vi.fn(),
  },
  requestAuthSession: authBoundaryMocks.requestAuthSession,
}))

vi.mock('@proj-airi/electron-vueuse', () => ({
  useElectronEventaContext: () => ({
    value: {
      on: (event: EventDefinition, handler: ContextHandler) => {
        if (event.id)
          electronMocks.contextHandlers.set(event.id, handler)
      },
    },
  }),
  useElectronEventaInvoke: (event: EventDefinition) => {
    if (event.sendEvent?.id.includes('auth:start-login'))
      return electronMocks.startSigningIn
    return electronMocks.openSettings
  },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

type AuthStore = ReturnType<typeof useAuthStore>

let authStore: AuthStore
let pinia: ReturnType<typeof createPinia>

const testUser = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  email: 'rainbow@example.com',
  emailVerified: true,
  id: 'rainbow-bird',
  image: 'https://example.com/broken-avatar.png',
  name: 'Rainbow Bird',
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
}

const testSession = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-01-02T00:00:00.000Z'),
  id: 'rainbow-session',
  token: 'rainbow-session-token',
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  userId: testUser.id,
}

function setAuthenticated(value: boolean) {
  authStore.user = value ? { ...testUser } : null
  authStore.session = value ? { ...testSession } : null
}

function getLoginButton() {
  const button = document.body.querySelector('button')
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

async function renderButton() {
  return render(ControlsIslandAuthButton, {
    global: {
      plugins: [pinia],
    },
  })
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  authStore = useAuthStore()
  setAuthenticated(true)
  authStore.needsLogin = false
  authStore.credits = 9620

  electronMocks.contextHandlers.clear()
  electronMocks.openSettings.mockReset()
  electronMocks.startSigningIn.mockReset()
  electronMocks.startSigningIn.mockResolvedValue({ attemptId: 1 })
  authBoundaryMocks.getFlux.mockReset()
  authBoundaryMocks.getFlux.mockResolvedValue({
    json: async () => ({ flux: 9620 }),
    ok: true,
  })
  authBoundaryMocks.requestAuthSession.mockReset()
  authBoundaryMocks.requestAuthSession.mockResolvedValue(null)
  authBoundaryMocks.triggerSignIn.mockReset()
})

describe('controlsIslandAuthButton', () => {
  it('renders the shared account fallback when no avatar is available', async () => {
    authStore.user = { ...testUser, image: null }
    await renderButton()

    const fallback = document.body.querySelector('[data-avatar-fallback]')
    expect(fallback).toBeTruthy()
    expect(fallback?.firstElementChild?.classList.contains('i-solar:user-circle-bold-duotone')).toBe(true)
  })

  it('tries the next avatar URL after the authenticated user changes', async () => {
    await renderButton()
    const previousImage = document.body.querySelector('[data-avatar-image]')

    authStore.user = { ...testUser, image: 'https://example.com/new-avatar.png' }
    await nextTick()

    const nextImage = document.body.querySelector('[data-avatar-image]')
    expect(nextImage).not.toBe(previousImage)
    expect(nextImage?.getAttribute('src')).toBe('https://example.com/new-avatar.png')
    expect(nextImage?.getAttribute('alt')).toBe('')
  })

  // https://github.com/moeru-ai/airi/issues/2182
  it('ignores duplicate login clicks while the IPC request is pending for Issue #2182', async () => {
    // ROOT CAUSE:
    //
    // The login button started a new IPC request on every click while its
    // existing request was still pending, so one renderer could launch
    // multiple main-process login attempts.
    setAuthenticated(false)
    const request = createDeferred<void>()
    electronMocks.startSigningIn.mockReturnValue(request.promise)
    await renderButton()

    const button = getLoginButton()
    button.click()
    button.click()

    await vi.waitFor(() => {
      expect(electronMocks.startSigningIn).toHaveBeenCalledTimes(1)
    })

    request.resolve()
    await request.promise
  })

  // https://github.com/moeru-ai/airi/issues/2182
  it('coalesces a pending click and needs-login notification for Issue #2182', async () => {
    // ROOT CAUSE:
    //
    // The login button and needs-login watcher could each start an IPC
    // request for the same pending login action.
    setAuthenticated(false)
    const request = createDeferred<void>()
    electronMocks.startSigningIn.mockReturnValue(request.promise)
    await renderButton()

    getLoginButton().click()
    authStore.needsLogin = true

    await vi.waitFor(() => {
      expect(electronMocks.startSigningIn).toHaveBeenCalledTimes(1)
    })
    expect(authStore.needsLogin).toBe(false)

    request.resolve()
    await request.promise
  })

  it.each([
    ['the success callback', electronAuthCallback],
    ['the error callback', electronAuthCallbackError],
  ])('allows a new login after %s', async (_, terminalEvent) => {
    setAuthenticated(false)
    const firstRequest = createDeferred<{ attemptId: number }>()
    const secondRequest = createDeferred<{ attemptId: number }>()
    electronMocks.startSigningIn
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise)
    await renderButton()

    getLoginButton().click()
    await vi.waitFor(() => {
      expect(electronMocks.startSigningIn).toHaveBeenCalledTimes(1)
    })

    const handler = electronMocks.contextHandlers.get(terminalEvent.id)
    expect(handler).toBeTypeOf('function')
    handler?.({ body: { attemptId: 1 } })
    firstRequest.resolve({ attemptId: 1 })
    await firstRequest.promise

    await vi.waitFor(() => {
      expect(document.body.querySelector('button')).toBeTruthy()
    })
    getLoginButton().click()
    await vi.waitFor(() => {
      expect(electronMocks.startSigningIn).toHaveBeenCalledTimes(2)
    })

    secondRequest.resolve({ attemptId: 2 })
    await secondRequest.promise
  })

  // https://github.com/moeru-ai/airi/issues/2182
  it('allows a new login after the IPC transport rejects for Issue #2182', async () => {
    // ROOT CAUSE:
    //
    // A rejected IPC invoke left the renderer in its loading state because
    // only main-process callback events cleared the flag.
    setAuthenticated(false)
    const firstRequest = createDeferred<{ attemptId: number }>()
    electronMocks.startSigningIn
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValueOnce(undefined)
    await renderButton()

    getLoginButton().click()
    await vi.waitFor(() => {
      expect(electronMocks.startSigningIn).toHaveBeenCalledTimes(1)
    })
    firstRequest.reject(new Error('IPC transport unavailable'))
    await firstRequest.promise.catch(() => {})
    await vi.waitFor(() => {
      expect(document.body.querySelector('button')).toBeTruthy()
    })

    getLoginButton().click()
    await vi.waitFor(() => {
      expect(electronMocks.startSigningIn).toHaveBeenCalledTimes(2)
    })
  })

  // https://github.com/moeru-ai/airi/issues/2182
  it('matches a terminal event that arrives before the start response for Issue #2182', async () => {
    // ROOT CAUSE:
    //
    // The main process can publish the terminal result before the renderer's
    // invoke promise resolves. The renderer must release this request without
    // letting the late response create another login action.
    setAuthenticated(false)
    const request = createDeferred<{ attemptId: number }>()
    electronMocks.startSigningIn.mockReturnValue(request.promise)
    await renderButton()

    getLoginButton().click()
    await vi.waitFor(() => {
      expect(electronMocks.startSigningIn).toHaveBeenCalledTimes(1)
    })

    const settledHandler = electronMocks.contextHandlers.get(electronAuthAttemptSettled.id)
    expect(settledHandler).toBeTypeOf('function')
    settledHandler?.({ body: { attemptId: 3 } })

    await nextTick()
    expect(document.body.querySelector('button')).toBeNull()

    request.resolve({ attemptId: 3 })
    await request.promise
    await vi.waitFor(() => {
      expect(document.body.querySelector('button')).toBeTruthy()
    })
  })

  // https://github.com/moeru-ai/airi/issues/2182
  it('ignores a stale terminal event after a newer login starts for Issue #2182', async () => {
    // ROOT CAUSE:
    //
    // A terminal event from an older attempt could clear the loading state of
    // a newer renderer request when the events did not carry an attempt ID.
    setAuthenticated(false)
    const firstRequest = createDeferred<{ attemptId: number }>()
    const secondRequest = createDeferred<{ attemptId: number }>()
    electronMocks.startSigningIn
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise)
    await renderButton()

    getLoginButton().click()
    await vi.waitFor(() => {
      expect(electronMocks.startSigningIn).toHaveBeenCalledTimes(1)
    })
    const callbackHandler = electronMocks.contextHandlers.get(electronAuthCallback.id)
    expect(callbackHandler).toBeTypeOf('function')
    callbackHandler?.({ body: { attemptId: 4 } })
    firstRequest.resolve({ attemptId: 4 })
    await firstRequest.promise
    await vi.waitFor(() => {
      expect(document.body.querySelector('button')).toBeTruthy()
    })

    getLoginButton().click()
    await vi.waitFor(() => {
      expect(electronMocks.startSigningIn).toHaveBeenCalledTimes(2)
    })

    const errorHandler = electronMocks.contextHandlers.get(electronAuthCallbackError.id)
    expect(errorHandler).toBeTypeOf('function')
    errorHandler?.({ body: { attemptId: 4 } })
    await nextTick()
    expect(document.body.querySelector('button')).toBeNull()

    secondRequest.resolve({ attemptId: 5 })
    await secondRequest.promise
    await nextTick()
    expect(document.body.querySelector('button')).toBeNull()
  })
})
