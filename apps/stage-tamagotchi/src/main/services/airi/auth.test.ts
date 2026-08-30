import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { BrowserWindow } from 'electron'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  electronAuthAttemptSettled,
  electronAuthCallback,
  electronAuthCallbackError,
  electronAuthLogout,
  electronAuthStartLogin,
} from '../../../shared/eventa'
import { createAuthService } from './auth'

type MainContext = ReturnType<typeof createContext>['context']

interface InvokeOptions {
  raw: { ipcMainEvent: { sender: { id: number } } }
}

interface InvokeHandler {
  (payload: undefined, options: InvokeOptions): unknown | Promise<unknown>
}

interface MockLoopbackServer {
  port: number
  result: Promise<{ code: string }>
  close: ReturnType<typeof vi.fn>
}

interface RegisteredHandler {
  context: MainContext
  eventId: string
  handler: InvokeHandler
}

interface MockWindow {
  close: () => void
  isDestroyed: () => boolean
  once: (event: string, handler: () => void) => void
}

interface InvokeEvent {
  id?: string
  sendEvent?: { id: string }
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

const registeredHandlers = vi.hoisted(() => [] as RegisteredHandler[])
const createdWindows = vi.hoisted(() => [] as MockWindow[])

const testMocks = vi.hoisted(() => ({
  defineInvokeHandler: vi.fn((context: MainContext, event: InvokeEvent, handler: InvokeHandler) => {
    registeredHandlers.push({ context, eventId: event.sendEvent?.id ?? event.id ?? '', handler })
    return vi.fn()
  }),
  fetch: vi.fn(),
  generateCodeChallenge: vi.fn(),
  generateCodeVerifier: vi.fn(),
  generateState: vi.fn(),
  openExternal: vi.fn(),
  startLoopbackServer: vi.fn(),
}))

vi.mock('@moeru/eventa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moeru/eventa')>()
  return {
    ...actual,
    defineInvokeHandler: testMocks.defineInvokeHandler,
  }
})

vi.mock('@guiiai/logg', () => ({
  useLogg: () => ({
    useGlobalConfig: () => ({
      log: vi.fn(),
      withError: () => ({ error: vi.fn() }),
      withFields: () => ({ warn: vi.fn() }),
    }),
  }),
}))

vi.mock('@moeru/std', async importOriginal => importOriginal<typeof import('@moeru/std')>())

vi.mock('@proj-airi/stage-shared/auth', () => ({
  generateCodeChallenge: testMocks.generateCodeChallenge,
  generateCodeVerifier: testMocks.generateCodeVerifier,
  generateState: testMocks.generateState,
}))

vi.mock('electron', () => ({
  shell: {
    openExternal: testMocks.openExternal,
  },
}))

vi.mock('./http-server/http/auth', () => ({
  startLoopbackServer: testMocks.startLoopbackServer,
}))

function createContextMock() {
  const emit = vi.fn().mockResolvedValue(undefined)
  return {
    emit,
    context: { emit } as unknown as MainContext,
  }
}

function createWindow(id: number) {
  let destroyed = false
  let closedHandler: (() => void) | undefined
  const window: MockWindow & { webContents: { id: number } } = {
    close: () => {
      if (destroyed)
        return
      destroyed = true
      closedHandler?.()
    },
    isDestroyed: () => destroyed,
    once: (event, handler) => {
      if (event === 'closed')
        closedHandler = handler
    },
    webContents: { id },
  }
  createdWindows.push(window)
  return window as BrowserWindow
}

function createLoopbackServer(result: Promise<{ code: string }>, port = 43123): MockLoopbackServer {
  return {
    close: vi.fn(),
    port,
    result,
  }
}

async function invoke(event: InvokeEvent, senderId: number): Promise<unknown[]> {
  const options: InvokeOptions = {
    raw: {
      ipcMainEvent: {
        sender: { id: senderId },
      },
    },
  }

  const eventId = event.sendEvent?.id ?? event.id ?? ''
  const responses: unknown[] = []
  for (const registeredHandler of registeredHandlers.filter(handler => handler.eventId === eventId))
    responses.push(await registeredHandler.handler(undefined, options))
  return responses
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('createAuthService', () => {
  beforeEach(() => {
    let attempt = 0
    testMocks.defineInvokeHandler.mockClear()
    testMocks.fetch.mockReset()
    testMocks.generateCodeChallenge.mockReset()
    testMocks.generateCodeVerifier.mockReset()
    testMocks.generateState.mockReset()
    testMocks.openExternal.mockReset()
    testMocks.startLoopbackServer.mockReset()
    testMocks.generateCodeVerifier.mockImplementation(() => `verifier-${++attempt}`)
    testMocks.generateCodeChallenge.mockImplementation(async (verifier: string) => `${verifier}-challenge`)
    testMocks.generateState.mockImplementation(() => `state-${attempt}`)
    testMocks.openExternal.mockResolvedValue(undefined)
    testMocks.fetch.mockResolvedValue({
      json: async () => ({
        access_token: 'access-token',
        expires_in: 3600,
        id_token: 'id-token',
        refresh_token: 'refresh-token',
      }),
      ok: true,
      text: async () => '',
    })
    registeredHandlers.length = 0
    vi.stubGlobal('fetch', testMocks.fetch)
  })

  afterEach(async () => {
    for (const windowId of [1, 2, 3]) {
      await invoke(electronAuthLogout, windowId)
    }
    for (const window of createdWindows)
      window.close()
    createdWindows.length = 0
    await flushPromises()
    registeredHandlers.length = 0
    vi.unstubAllGlobals()
  })

  // https://github.com/moeru-ai/airi/issues/2182
  it('coalesces duplicate starts without closing the active loopback for Issue #2182', async () => {
    // ROOT CAUSE:
    //
    // A duplicate start closed the active loopback server.
    // Its cancellation rejection published an error, and stale cleanup cleared shared state.
    //
    // Before this fix, the second request replaced the first request while its asynchronous setup was still active.
    //
    // We fixed this by storing one identity-correlated attempt and coalescing every duplicate request.
    const context = createContextMock()
    createAuthService({ context: context.context, window: createWindow(1) })
    const startup = createDeferred<MockLoopbackServer>()
    const result = createDeferred<{ code: string }>()
    testMocks.startLoopbackServer.mockReturnValue(startup.promise)

    const firstStart = invoke(electronAuthStartLogin, 1)
    await flushPromises()
    expect(testMocks.startLoopbackServer).toHaveBeenCalledTimes(1)

    const secondStart = invoke(electronAuthStartLogin, 1)
    await flushPromises()
    expect(testMocks.startLoopbackServer).toHaveBeenCalledTimes(1)
    expect(testMocks.openExternal).not.toHaveBeenCalled()

    const loopback = createLoopbackServer(result.promise)
    startup.resolve(loopback)
    await firstStart
    await secondStart

    expect(testMocks.openExternal).toHaveBeenCalledTimes(1)
    expect(loopback.close).not.toHaveBeenCalled()
    expect(context.emit).not.toHaveBeenCalledWith(electronAuthCallbackError, expect.anything())
  })

  // https://github.com/moeru-ai/airi/issues/2182
  it('coalesces registrations and settles every live participant for Issue #2182', async () => {
    // ROOT CAUSE:
    //
    // Auth registrations used replacement state, so a second window could close and clear the first window's attempt.
    //
    // Before this fix, the shared flags did not identify the context that owned a terminal event.
    //
    // We fixed this by correlating all asynchronous work with the first attempt object and its owner context.
    const owner = createContextMock()
    const duplicate = createContextMock()
    createAuthService({ context: owner.context, window: createWindow(1) })
    createAuthService({ context: duplicate.context, window: createWindow(2) })
    const result = createDeferred<{ code: string }>()
    const loopback = createLoopbackServer(result.promise)
    testMocks.startLoopbackServer.mockResolvedValue(loopback)

    const ownerStart = await invoke(electronAuthStartLogin, 1)
    const duplicateStart = await invoke(electronAuthStartLogin, 2)
    const attemptId = ownerStart.find(response => response !== undefined)

    expect(testMocks.startLoopbackServer).toHaveBeenCalledTimes(1)
    expect(loopback.close).not.toHaveBeenCalled()
    expect(duplicateStart.find(response => response !== undefined)).toEqual(attemptId)
    expect(attemptId).toEqual({ attemptId: expect.any(Number) })

    result.resolve({ code: 'authorization-code' })
    await flushPromises()

    expect(owner.emit).toHaveBeenCalledWith(electronAuthCallback, {
      attemptId: (attemptId as { attemptId: number }).attemptId,
      tokens: {
        accessToken: 'access-token',
        expiresIn: 3600,
        idToken: 'id-token',
        refreshToken: 'refresh-token',
      },
    })
    expect(duplicate.emit).toHaveBeenCalledWith(electronAuthAttemptSettled, attemptId)
  })

  it('rejects invalid senders without starting or cancelling the attempt', async () => {
    const context = createContextMock()
    createAuthService({ context: context.context, window: createWindow(1) })
    const result = createDeferred<{ code: string }>()
    const loopback = createLoopbackServer(result.promise)
    testMocks.startLoopbackServer.mockResolvedValue(loopback)

    await invoke(electronAuthStartLogin, 99)
    expect(testMocks.startLoopbackServer).not.toHaveBeenCalled()

    await invoke(electronAuthStartLogin, 1)
    await invoke(electronAuthLogout, 99)
    expect(loopback.close).not.toHaveBeenCalled()

    await invoke(electronAuthLogout, 1)
    expect(loopback.close).toHaveBeenCalledTimes(1)
  })

  // https://github.com/moeru-ai/airi/issues/2182
  it('ignores stale cancellation cleanup after a later attempt starts for Issue #2182', async () => {
    // ROOT CAUSE:
    //
    // Attempt A could reject after logout and clear the state for attempt B.
    //
    // Before this fix, cleanup used loose module globals instead of the attempt that created the asynchronous work.
    //
    // We fixed this by allowing only the active attempt object to publish or clear state.
    const context = createContextMock()
    createAuthService({ context: context.context, window: createWindow(1) })
    const attemptA = createDeferred<{ code: string }>()
    const attemptB = createDeferred<{ code: string }>()
    const loopbackA = createLoopbackServer(attemptA.promise, 43123)
    const loopbackB = createLoopbackServer(attemptB.promise, 43124)
    testMocks.startLoopbackServer
      .mockResolvedValueOnce(loopbackA)
      .mockResolvedValueOnce(loopbackB)

    const attemptAStart = await invoke(electronAuthStartLogin, 1)
    await invoke(electronAuthLogout, 1)
    const attemptBStart = await invoke(electronAuthStartLogin, 1)
    const attemptBId = attemptBStart.find(response => response !== undefined)
    expect(attemptBId).not.toEqual(attemptAStart.find(response => response !== undefined))

    attemptA.reject(new Error('OIDC sign-in attempt cancelled'))
    await flushPromises()
    expect(context.emit).not.toHaveBeenCalledWith(electronAuthCallbackError, expect.anything())

    attemptB.resolve({ code: 'authorization-code-b' })
    await flushPromises()
    expect(context.emit).toHaveBeenCalledWith(electronAuthCallback, {
      attemptId: (attemptBId as { attemptId: number }).attemptId,
      tokens: {
        accessToken: 'access-token',
        expiresIn: 3600,
        idToken: 'id-token',
        refreshToken: 'refresh-token',
      },
    })
    expect(loopbackB.close).not.toHaveBeenCalled()
  })

  // https://github.com/moeru-ai/airi/issues/2182
  it('closes a loopback that finishes startup after logout for Issue #2182', async () => {
    // ROOT CAUSE:
    //
    // Logout could finish before loopback startup, then late startup still opened the browser.
    //
    // Before this fix, the late server replaced the shared close handle after cancellation.
    //
    // We fixed this by closing stale loopbacks after startup and before browser setup.
    const context = createContextMock()
    createAuthService({ context: context.context, window: createWindow(1) })
    const startup = createDeferred<MockLoopbackServer>()
    testMocks.startLoopbackServer.mockReturnValue(startup.promise)

    const start = invoke(electronAuthStartLogin, 1)
    await flushPromises()
    await invoke(electronAuthLogout, 1)

    const result = createDeferred<{ code: string }>()
    const loopback = createLoopbackServer(result.promise)
    startup.resolve(loopback)
    const attemptId = (await start).find(response => response !== undefined)
    await flushPromises()

    expect(loopback.close).toHaveBeenCalledTimes(1)
    expect(testMocks.openExternal).not.toHaveBeenCalled()
    expect(context.emit).toHaveBeenCalledWith(electronAuthAttemptSettled, attemptId)
    expect(context.emit).not.toHaveBeenCalledWith(electronAuthCallbackError, expect.anything())
  })

  // https://github.com/moeru-ai/airi/issues/2182
  it('hands success to a live primary after the participant owner closes for Issue #2182', async () => {
    // ROOT CAUSE:
    //
    // The onboarding window can close immediately after starting login, so a callback
    // sent only through its fixed context is dropped before the auth bridge can consume it.
    //
    // We fixed this by tracking live registrations and selecting one live renderer for the
    // terminal token callback after the original owner disappears.
    const primary = createContextMock()
    const owner = createContextMock()
    const primaryWindow = createWindow(1)
    const ownerWindow = createWindow(2)
    createAuthService({
      context: primary.context,
      role: 'primary',
      window: primaryWindow,
    })
    createAuthService({ context: owner.context, window: ownerWindow })
    const result = createDeferred<{ code: string }>()
    const loopback = createLoopbackServer(result.promise)
    testMocks.startLoopbackServer.mockResolvedValue(loopback)

    const ownerStart = await invoke(electronAuthStartLogin, 2)
    const attemptId = ownerStart.find(response => response !== undefined)
    expect(attemptId).toEqual({ attemptId: expect.any(Number) })

    ownerWindow.close()
    result.resolve({ code: 'authorization-code' })
    await flushPromises()

    expect(primary.emit).toHaveBeenCalledWith(electronAuthCallback, {
      attemptId: (attemptId as { attemptId: number }).attemptId,
      tokens: {
        accessToken: 'access-token',
        expiresIn: 3600,
        idToken: 'id-token',
        refreshToken: 'refresh-token',
      },
    })
    expect(owner.emit).not.toHaveBeenCalled()
  })

  // https://github.com/moeru-ai/airi/issues/2182
  it('publishes tokens once through the primary and settles a live participant for Issue #2182', async () => {
    // ROOT CAUSE:
    //
    // Sending a successful callback to every joined window would make multiple
    // renderers persist the same tokens and request the same session.
    //
    // We fixed this by selecting one primary token consumer and sending only a
    // silent attempt-settled event to the other live participants.
    const primary = createContextMock()
    const participant = createContextMock()
    createAuthService({
      context: primary.context,
      role: 'primary',
      window: createWindow(1),
    })
    createAuthService({ context: participant.context, window: createWindow(2) })
    const result = createDeferred<{ code: string }>()
    testMocks.startLoopbackServer.mockResolvedValue(createLoopbackServer(result.promise))

    const start = await invoke(electronAuthStartLogin, 2)
    const attemptId = start.find(response => response !== undefined)
    expect(attemptId).toEqual({ attemptId: expect.any(Number) })

    result.resolve({ code: 'authorization-code' })
    await flushPromises()

    expect(primary.emit).toHaveBeenCalledWith(electronAuthCallback, {
      attemptId: (attemptId as { attemptId: number }).attemptId,
      tokens: {
        accessToken: 'access-token',
        expiresIn: 3600,
        idToken: 'id-token',
        refreshToken: 'refresh-token',
      },
    })
    expect(primary.emit).toHaveBeenCalledTimes(1)
    expect(participant.emit).toHaveBeenCalledWith(electronAuthAttemptSettled, attemptId)
    expect(participant.emit).toHaveBeenCalledTimes(1)
  })

  // https://github.com/moeru-ai/airi/issues/2182
  it('settles a duplicate when the owner receives one visible failure for Issue #2182', async () => {
    // ROOT CAUSE:
    //
    // A fixed owner context could either lose the terminal error when its window closed or
    // show the same provider error in multiple renderers after duplicate starts joined it.
    //
    // We fixed this by routing one visible error to a live participant and sending a silent
    // attempt-settled event to the other participants.
    const primary = createContextMock()
    const participant = createContextMock()
    createAuthService({
      context: primary.context,
      role: 'primary',
      window: createWindow(1),
    })
    createAuthService({ context: participant.context, window: createWindow(2) })
    const result = createDeferred<{ code: string }>()
    const loopback = createLoopbackServer(result.promise)
    testMocks.startLoopbackServer.mockResolvedValue(loopback)

    const primaryStart = await invoke(electronAuthStartLogin, 1)
    const participantStart = await invoke(electronAuthStartLogin, 2)
    const attemptId = primaryStart.find(response => response !== undefined)
    expect(participantStart.find(response => response !== undefined)).toEqual(attemptId)
    expect(attemptId).toEqual({ attemptId: expect.any(Number) })

    result.reject(new Error('provider denied'))
    await flushPromises()

    const resolvedAttemptId = (attemptId as { attemptId: number }).attemptId
    expect(primary.emit).toHaveBeenCalledWith(electronAuthCallbackError, {
      attemptId: resolvedAttemptId,
      error: 'provider denied',
    })
    expect(participant.emit).toHaveBeenCalledWith(electronAuthAttemptSettled, {
      attemptId: resolvedAttemptId,
    })
    expect(participant.emit).not.toHaveBeenCalledWith(electronAuthCallbackError, expect.anything())
  })

  it('publishes one active success with the original PKCE and redirect values', async () => {
    const context = createContextMock()
    createAuthService({ context: context.context, window: createWindow(1) })
    const result = createDeferred<{ code: string }>()
    const loopback = createLoopbackServer(result.promise, 43125)
    testMocks.startLoopbackServer.mockResolvedValue(loopback)

    const start = await invoke(electronAuthStartLogin, 1)
    const attemptId = start.find(response => response !== undefined)
    expect(attemptId).toEqual({ attemptId: expect.any(Number) })
    result.resolve({ code: 'authorization-code' })
    await flushPromises()

    expect(testMocks.fetch).toHaveBeenCalledTimes(1)
    const [tokenUrl, request] = testMocks.fetch.mock.calls[0] as [URL, RequestInit]
    expect(tokenUrl.toString()).toBe('https://api.airi.build/api/auth/oauth2/token')
    expect(request.body).toBeInstanceOf(URLSearchParams)
    expect((request.body as URLSearchParams).get('code_verifier')).toBe('verifier-1')
    expect((request.body as URLSearchParams).get('redirect_uri')).toBe('https://api.airi.build/api/auth/oidc/electron-callback')
    expect(context.emit).toHaveBeenCalledTimes(1)
    expect(context.emit).toHaveBeenCalledWith(electronAuthCallback, {
      attemptId: (attemptId as { attemptId: number }).attemptId,
      tokens: expect.objectContaining({ accessToken: 'access-token' }),
    })
  })

  it('publishes one active failure and keeps logout cancellation internal', async () => {
    const context = createContextMock()
    createAuthService({ context: context.context, window: createWindow(1) })
    const result = createDeferred<{ code: string }>()
    const loopback = createLoopbackServer(result.promise)
    testMocks.startLoopbackServer.mockResolvedValue(loopback)

    const start = await invoke(electronAuthStartLogin, 1)
    const attemptId = start.find(response => response !== undefined)
    expect(attemptId).toEqual({ attemptId: expect.any(Number) })
    result.reject(new Error('provider denied'))
    await flushPromises()

    expect(context.emit).toHaveBeenCalledWith(electronAuthCallbackError, {
      attemptId: (attemptId as { attemptId: number }).attemptId,
      error: 'provider denied',
    })
    expect(context.emit).toHaveBeenCalledTimes(1)

    const nextResult = createDeferred<{ code: string }>()
    const nextLoopback = createLoopbackServer(nextResult.promise)
    testMocks.startLoopbackServer.mockResolvedValue(nextLoopback)
    await invoke(electronAuthStartLogin, 1)
    await invoke(electronAuthLogout, 1)
    nextResult.reject(new Error('OIDC sign-in attempt cancelled'))
    await flushPromises()

    expect(context.emit).toHaveBeenCalledTimes(2)
    expect(context.emit).toHaveBeenCalledWith(electronAuthAttemptSettled, expect.objectContaining({ attemptId: expect.any(Number) }))
  })

  it('handles setup errors after loopback startup without an unhandled result rejection', async () => {
    const context = createContextMock()
    createAuthService({ context: context.context, window: createWindow(1) })
    const result = createDeferred<{ code: string }>()
    const loopback = createLoopbackServer(result.promise)
    testMocks.startLoopbackServer.mockResolvedValue(loopback)
    testMocks.openExternal.mockRejectedValue(new Error('browser unavailable'))

    const start = await invoke(electronAuthStartLogin, 1)
    const attemptId = start.find(response => response !== undefined)
    expect(attemptId).toEqual({ attemptId: expect.any(Number) })
    await flushPromises()

    expect(loopback.close).toHaveBeenCalledTimes(1)
    expect(context.emit).toHaveBeenCalledWith(electronAuthCallbackError, {
      attemptId: (attemptId as { attemptId: number }).attemptId,
      error: 'browser unavailable',
    })
    expect(context.emit).toHaveBeenCalledTimes(1)
  })
})
