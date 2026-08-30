import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { BrowserWindow } from 'electron'

import type {
  ElectronAuthAttemptRef,
  ElectronAuthAttemptSettledPayload,
  ElectronAuthTokens,
} from '../../../shared/eventa'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '@proj-airi/stage-shared/auth'
import { shell } from 'electron'

import {
  electronAuthAttemptSettled,
  electronAuthCallback,
  electronAuthCallbackError,
  electronAuthLogout,
  electronAuthStartLogin,
} from '../../../shared/eventa'
import { startLoopbackServer } from './http-server/http/auth'

const log = useLogg('auth-service').useGlobalConfig()

type MainContext = ReturnType<typeof createContext>['context']

// OIDC configuration for the Electron client.
const OIDC_CLIENT_ID = import.meta.env.VITE_OIDC_CLIENT_ID || 'airi-stage-electron'
const OIDC_SCOPES = 'openid profile email offline_access'
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'https://api.airi.build'
const OIDC_AUTHORIZE_PATH = '/api/auth/oauth2/authorize'
const OIDC_TOKEN_PATH = '/api/auth/oauth2/token'

type AuthWindowRole = 'primary' | 'participant'

interface AuthRegistration {
  context: MainContext
  role: AuthWindowRole
  window: BrowserWindow
}

interface LoginAttempt {
  attemptId: number
  ownerWindowId: number
  participants: Set<AuthRegistration>
  cancelled: boolean
  closeLoopback: (() => void) | null
}

// Object identity correlates every asynchronous operation with the attempt that owns it.
let activeLoginAttempt: LoginAttempt | null = null
let nextAttemptId = 0
const authRegistrations = new Set<AuthRegistration>()

function registerAuthWindow(params: {
  context: MainContext
  window: BrowserWindow
  role?: AuthWindowRole
}): AuthRegistration {
  const registration: AuthRegistration = {
    context: params.context,
    role: params.role ?? 'participant',
    window: params.window,
  }
  authRegistrations.add(registration)
  params.window.once('closed', () => {
    authRegistrations.delete(registration)
    activeLoginAttempt?.participants.delete(registration)
  })
  return registration
}

function isLiveRegistration(registration: AuthRegistration): boolean {
  return authRegistrations.has(registration) && !registration.window.isDestroyed()
}

function attemptRef(attempt: LoginAttempt): ElectronAuthAttemptRef {
  return { attemptId: attempt.attemptId }
}

function liveParticipants(attempt: LoginAttempt): AuthRegistration[] {
  return [...attempt.participants].filter(isLiveRegistration)
}

function firstLiveRegistration(): AuthRegistration | undefined {
  return [...authRegistrations].find(isLiveRegistration)
}

function livePrimaryRegistration(): AuthRegistration | undefined {
  return [...authRegistrations].find(registration => registration.role === 'primary' && isLiveRegistration(registration))
}

function selectTerminalRecipient(attempt: LoginAttempt, outcome: 'success' | 'failure'): AuthRegistration | undefined {
  const participants = liveParticipants(attempt)
  if (outcome === 'success') {
    return livePrimaryRegistration()
      ?? participants[0]
      ?? firstLiveRegistration()
  }

  return participants.find(registration => registration.window.webContents.id === attempt.ownerWindowId)
    ?? participants[0]
    ?? livePrimaryRegistration()
    ?? firstLiveRegistration()
}

function publishAttemptSettled(attempt: LoginAttempt, recipient?: AuthRegistration): void {
  const payload: ElectronAuthAttemptSettledPayload = attemptRef(attempt)
  for (const participant of attempt.participants) {
    if (participant === recipient || !isLiveRegistration(participant)) {
      continue
    }
    participant.context.emit(electronAuthAttemptSettled, payload)
  }
}

function publishAttemptSuccess(attempt: LoginAttempt, tokens: ElectronAuthTokens): void {
  const recipient = selectTerminalRecipient(attempt, 'success')
  if (recipient && isLiveRegistration(recipient)) {
    recipient.context.emit(electronAuthCallback, {
      ...attemptRef(attempt),
      tokens,
    })
  }
  publishAttemptSettled(attempt, recipient)
}

function publishAttemptFailure(attempt: LoginAttempt, error: string): void {
  const recipient = selectTerminalRecipient(attempt, 'failure')
  if (recipient && isLiveRegistration(recipient)) {
    recipient.context.emit(electronAuthCallbackError, {
      ...attemptRef(attempt),
      error,
    })
  }
  publishAttemptSettled(attempt, recipient)
}

function closeAttemptLoopback(attempt: LoginAttempt): void {
  const closeLoopback = attempt.closeLoopback
  attempt.closeLoopback = null
  try {
    closeLoopback?.()
  }
  catch (err) {
    log.withError(err).error('Failed to close OIDC loopback server')
  }
}

function isActiveLoginAttempt(attempt: LoginAttempt): boolean {
  return activeLoginAttempt === attempt && !attempt.cancelled
}

function cancelActiveLoginAttempt(): void {
  const attempt = activeLoginAttempt
  if (!attempt) {
    return
  }

  attempt.cancelled = true
  if (activeLoginAttempt !== attempt) {
    return
  }

  activeLoginAttempt = null
  closeAttemptLoopback(attempt)
  publishAttemptSettled(attempt)
}

/**
 * Create the auth service IPC handlers for a given window context.
 */
export function createAuthService(params: {
  context: MainContext
  window: BrowserWindow
  role?: AuthWindowRole
}): void {
  const registration = registerAuthWindow(params)

  defineInvokeHandler(registration.context, electronAuthStartLogin, async (_, options) => {
    if (!isLiveRegistration(registration) || registration.window.webContents.id !== options?.raw.ipcMainEvent.sender.id) {
      return undefined
    }

    if (activeLoginAttempt) {
      log.withFields({
        ownerWindowId: activeLoginAttempt.ownerWindowId,
        windowId: registration.window.webContents.id,
      }).warn('Coalescing duplicate OIDC login request')
      activeLoginAttempt.participants.add(registration)
      return attemptRef(activeLoginAttempt)
    }

    const attempt: LoginAttempt = {
      attemptId: ++nextAttemptId,
      cancelled: false,
      closeLoopback: null,
      ownerWindowId: registration.window.webContents.id,
      participants: new Set([registration]),
    }
    activeLoginAttempt = attempt

    try {
      const codeVerifier = generateCodeVerifier()
      const codeChallenge = await generateCodeChallenge(codeVerifier)
      const state = generateState()
      const redirectUri = `${SERVER_URL}/api/auth/oidc/electron-callback`

      // Start loopback server to receive the callback
      const loopback = await startLoopbackServer(state)
      attempt.closeLoopback = loopback.close

      // Attach the result pipeline before URL setup can throw. A cancelled or stale attempt
      // still needs a rejection handler when its loopback finishes startup.
      const resultPipeline = loopback.result
        .then(async ({ code }) => {
          if (!isActiveLoginAttempt(attempt)) {
            return
          }

          const tokens = await exchangeCode(code, codeVerifier, redirectUri)
          if (!isActiveLoginAttempt(attempt)) {
            return
          }

          publishAttemptSuccess(attempt, tokens)
          log.log('OIDC token exchange successful')
        })
        .catch((err) => {
          if (!isActiveLoginAttempt(attempt)) {
            return
          }

          log.withError(err).error('OIDC signing in failed')
          publishAttemptFailure(attempt, errorMessageFrom(err) ?? 'OIDC signing in failed')
        })
        .finally(() => {
          if (activeLoginAttempt !== attempt) {
            return
          }

          attempt.closeLoopback = null
          activeLoginAttempt = null
        })
      void resultPipeline

      if (!isActiveLoginAttempt(attempt)) {
        closeAttemptLoopback(attempt)
        return attemptRef(attempt)
      }

      // Use the server-side relay as redirect_uri. The relay page serves HTML
      // that forwards the authorization code to the loopback via JS fetch().
      // The loopback port is encoded in the state parameter as "{port}:{state}".
      const stateWithPort = `${loopback.port}:${state}`

      // Build authorization URL
      // NOTICE: prompt=login forces the authorization server to show the login
      // page even if the system browser has an existing session cookie. Without
      // this, the OIDC flow auto-completes silently using the stale cookie.
      const url = new URL(OIDC_AUTHORIZE_PATH, SERVER_URL)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', OIDC_CLIENT_ID)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', OIDC_SCOPES)
      url.searchParams.set('state', stateWithPort)
      url.searchParams.set('code_challenge', codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('prompt', 'login')
      url.searchParams.set('resource', SERVER_URL)

      // Open system browser
      if (!isActiveLoginAttempt(attempt)) {
        return attemptRef(attempt)
      }
      await shell.openExternal(url.toString())
    }
    catch (err) {
      if (!isActiveLoginAttempt(attempt)) {
        return attemptRef(attempt)
      }

      closeAttemptLoopback(attempt)
      activeLoginAttempt = null
      log.withError(err).error('Failed to start OIDC signing in flow')
      publishAttemptFailure(attempt, errorMessageFrom(err) ?? 'OIDC signing in failed')
    }

    return attemptRef(attempt)
  })

  defineInvokeHandler(registration.context, electronAuthLogout, async (_, options) => {
    if (!isLiveRegistration(registration) || registration.window.webContents.id !== options?.raw.ipcMainEvent.sender.id) {
      return
    }

    cancelActiveLoginAttempt()
  })
}

// --- Internal helpers ---

interface TokenExchangeResult {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresIn: number
}

async function exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: OIDC_CLIENT_ID,
    code_verifier: codeVerifier,
    resource: SERVER_URL,
  })

  const response = await fetch(new URL(OIDC_TOKEN_PATH, SERVER_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Token exchange failed (${response.status}): ${text}`)
  }

  const data = await response.json() as Record<string, unknown>
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string | undefined,
    idToken: data.id_token as string | undefined,
    expiresIn: data.expires_in as number,
  }
}
