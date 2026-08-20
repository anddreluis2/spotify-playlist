// Login with Authorization Code + PKCE: no client secret, token cached between runs.

import { spawn } from 'node:child_process'
import { hash, randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { parseEnv } from 'node:util'

import { ACCOUNTS_BASE, ENV_FILE, REDIRECT_URI, SCOPES, TOKEN_FILE } from './config.ts'

import type { StoredToken } from './types.ts'

/** Reads the .env at the root of the package; variables already in the environment win. */
export async function loadEnv(): Promise<void> {
  try {
    const parsed = parseEnv(await readFile(ENV_FILE, 'utf8')) as Record<string, string>
    for (const [key, value] of Object.entries(parsed)) process.env[key] ??= value
  } catch {
    // no .env: the environment is the only source
  }
}

async function readSavedToken(): Promise<StoredToken | null> {
  try {
    return JSON.parse(await readFile(TOKEN_FILE, 'utf8')) as StoredToken
  } catch {
    return null
  }
}

async function saveToken(token: StoredToken): Promise<void> {
  await mkdir(dirname(TOKEN_FILE), { recursive: true })
  await writeFile(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 })
}

async function requestToken(body: Record<string, string>): Promise<StoredToken> {
  const response = await fetch(`${ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.SPOTIFY_CLIENT_ID!, ...body }),
  })
  if (!response.ok) throw new Error(`Token request failed (${response.status}): ${await response.text()}`)

  const token = (await response.json()) as StoredToken
  token.expires_at = Date.now() + token.expires_in * 1000
  return token
}

/** Serves the single request the browser makes after the user authorizes. */
function waitForCallback(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', REDIRECT_URI)
      if (url.pathname !== REDIRECT_URI.pathname) return response.end()

      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<h2>${error ? `Error: ${error}` : 'You can close this tab.'}</h2>`)
      server.close()

      if (error) reject(new Error(error))
      else if (url.searchParams.get('state') !== expectedState) reject(new Error('state mismatch'))
      else if (!code) reject(new Error('no authorization code in the callback'))
      else resolve(code)
    })
    server.listen(Number(REDIRECT_URI.port), REDIRECT_URI.hostname)
    server.on('error', reject)
  })
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
}

async function authorizeInBrowser(): Promise<StoredToken> {
  const verifier = randomBytes(64).toString('base64url')
  const state = randomBytes(16).toString('base64url')
  const authUrl = `${ACCOUNTS_BASE}/authorize?${new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID!,
    response_type: 'code',
    redirect_uri: REDIRECT_URI.href,
    scope: SCOPES,
    state,
    code_challenge_method: 'S256',
    code_challenge: hash('sha256', verifier, 'base64url'),
  })}`

  const callback = waitForCallback(state)
  console.log(`Opening the browser to authorize...\nIf it does not open, visit:\n${authUrl}\n`)
  openBrowser(authUrl)

  return requestToken({
    grant_type: 'authorization_code',
    code: await callback,
    redirect_uri: REDIRECT_URI.href,
    code_verifier: verifier,
  })
}

/** Returns a usable access token: cached, refreshed, or freshly authorized. */
export async function authenticate(): Promise<string> {
  const saved = await readSavedToken()
  if (saved && saved.expires_at > Date.now() + 60_000) return saved.access_token

  if (saved?.refresh_token) {
    try {
      const token = await requestToken({ grant_type: 'refresh_token', refresh_token: saved.refresh_token })
      token.refresh_token ??= saved.refresh_token
      await saveToken(token)
      return token.access_token
    } catch {
      // refresh expired or revoked: fall through to the full flow
    }
  }

  const token = await authorizeInBrowser()
  await saveToken(token)
  return token.access_token
}
