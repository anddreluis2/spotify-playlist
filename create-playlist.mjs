#!/usr/bin/env node
// Create a Spotify playlist from a list of tracks, or replace the contents of an existing
// one, always preserving the order of the input file.
//
// Usage: node create-playlist.mjs --name "My Playlist" --file tracks.txt [--desc "..."] [--public]
//        node create-playlist.mjs --playlist <id|url> --file tracks.txt   (replaces its contents)
//
// Each line of the file: "spotify:track:ID", a Spotify URL, a bare ID, or "Artist - Song"
// (looked up through /search). Blank lines and lines starting with # are ignored.
//
// Spotify Web API quirks this tool works around — kept here so the call sites stay plain:
//   - GET /tracks?ids= (batch) answers 403 for apps in development mode; only GET /tracks/{id} works.
//   - POST /users/{id}/playlists answers 403; POST /me/playlists creates the same playlist.
//   - /playlists/{id}/tracks was replaced by /playlists/{id}/items on 2026-02-11 and now answers 403.
//   - Rate limits are per endpoint. A burst of GET /tracks/{id} can earn a Retry-After of ~24h,
//     which is why track names are read back from the playlist instead of looked up one by one.

import { spawn } from 'node:child_process'
import { hash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs, parseEnv } from 'node:util'

const REDIRECT_URI = new URL('http://127.0.0.1:8888/callback')
const SCOPES = 'playlist-modify-private playlist-modify-public playlist-read-private'
const TOKEN_FILE = join(homedir(), '.config', 'spotify-playlist', 'token.json')
const PAGE_SIZE = 100 // most items the API accepts in a single playlist request
const MAX_RETRY_WAIT_SECONDS = 30 // above this a 429 is reported instead of waited out

/* --------------------------------- helpers -------------------------------- */

function* chunks(items, size) {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

// Accepts a bare ID, "spotify:<kind>:ID" or a Spotify URL, and returns the ID.
function extractId(value, kind) {
  const patterns = [
    /^([A-Za-z0-9]{22})$/,
    new RegExp(`^spotify:${kind}:([A-Za-z0-9]{22})$`),
    new RegExp(`open\\.spotify\\.com/(?:intl-\\w+/)?${kind}/([A-Za-z0-9]{22})`),
  ]
  for (const pattern of patterns) {
    const match = value.match(pattern)
    if (match) return match[1]
  }
  return null
}

const trackLabel = (track) => `${track.artists.map((artist) => artist.name).join(', ')} - ${track.name}`

/* ---------------------------------- auth ---------------------------------- */

// Reads the .env next to this script; environment variables already set win.
async function loadEnv() {
  try {
    for (const [key, value] of Object.entries(parseEnv(await readFile(new URL('.env', import.meta.url), 'utf8')))) {
      process.env[key] ??= value
    }
  } catch {
    // no .env: the environment is the only source
  }
}

async function readSavedToken() {
  try {
    return JSON.parse(await readFile(TOKEN_FILE, 'utf8'))
  } catch {
    return null
  }
}

async function saveToken(token) {
  await mkdir(dirname(TOKEN_FILE), { recursive: true })
  await writeFile(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 })
}

async function requestToken(body) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.SPOTIFY_CLIENT_ID, ...body }),
  })
  if (!response.ok) throw new Error(`Token request failed (${response.status}): ${await response.text()}`)

  const token = await response.json()
  token.expires_at = Date.now() + token.expires_in * 1000
  return token
}

// Authorization Code + PKCE: opens the browser and listens for the callback.
function waitForCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, REDIRECT_URI)
      if (url.pathname !== REDIRECT_URI.pathname) return response.end()

      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<h2>${error ? `Error: ${error}` : 'You can close this tab.'}</h2>`)
      server.close()

      if (error) reject(new Error(error))
      else if (url.searchParams.get('state') !== expectedState) reject(new Error('state mismatch'))
      else resolve(code)
    })
    server.listen(Number(REDIRECT_URI.port), REDIRECT_URI.hostname)
    server.on('error', reject)
  })
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
}

// Returns a usable access token: cached, refreshed, or freshly authorized.
async function authenticate() {
  const saved = await readSavedToken()
  if (saved?.expires_at > Date.now() + 60_000) return saved.access_token

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

  const verifier = randomBytes(64).toString('base64url')
  const state = randomBytes(16).toString('base64url')
  const authUrl = `https://accounts.spotify.com/authorize?${new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
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

  const token = await requestToken({
    grant_type: 'authorization_code',
    code: await callback,
    redirect_uri: REDIRECT_URI.href,
    code_verifier: verifier,
  })
  await saveToken(token)
  return token.access_token
}

/* ----------------------------------- api ---------------------------------- */

// maxRetryWait caps how long a 429 is waited out; past it the error is reported so the
// caller can decide (waiting out a 24h backoff is never what anyone wants).
async function api(token, path, { maxRetryWait = MAX_RETRY_WAIT_SECONDS, ...options } = {}) {
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
  })

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') ?? 2)
    if (retryAfter <= maxRetryWait) {
      await sleep((retryAfter + 1) * 1000)
      return api(token, path, { maxRetryWait, ...options })
    }
  }

  if (!response.ok) {
    const error = new Error(`${options.method ?? 'GET'} ${path} -> ${response.status}: ${await response.text()}`)
    error.status = response.status
    throw error
  }

  return response.status === 204 ? null : response.json()
}

/* --------------------------------- tracks --------------------------------- */

// "Artist - Song" becomes a fielded query; a line without a separator has no structured form.
function buildQuery(line) {
  const parts = line.split(/\s+[-–—]\s+/)
  if (parts.length < 2) return null

  const [artist, ...rest] = parts
  return `track:${rest.join(' - ')} artist:${artist}`
}

async function searchTrack(token, line) {
  for (const query of [buildQuery(line), line]) {
    if (!query) continue
    const result = await api(token, `/search?${new URLSearchParams({ q: query, type: 'track', limit: '1' })}`)
    if (result.tracks.items[0]) return result.tracks.items[0]
  }
  return null
}

// One entry per input line, in order: an id when the track is known, null when it is not.
async function resolveLines(token, lines) {
  const entries = []

  for (const line of lines) {
    const id = extractId(line, 'track')
    if (id) {
      entries.push({ line, id })
      continue
    }
    const track = await searchTrack(token, line)
    entries.push({ line, id: track?.id ?? null, label: track && trackLabel(track) })
  }

  return entries
}

// Only used to explain a rejected write: one request per id, so never on the happy path.
async function findInvalidIds(token, ids) {
  const invalid = []

  for (const id of ids) {
    try {
      await api(token, `/tracks/${id}`, { maxRetryWait: 0 })
    } catch (error) {
      if (error.status !== 404 && error.status !== 400) throw error
      invalid.push(id)
    }
  }

  return invalid
}

/* -------------------------------- playlist -------------------------------- */

// Only the fields the caller actually asked for, so updates do not reset untouched ones.
function metadataFrom(args, { isNew }) {
  return {
    ...(args.name !== undefined && { name: args.name }),
    ...(args.desc !== undefined && { description: args.desc }),
    ...((args.public !== undefined || isNew) && { public: args.public ?? false }),
  }
}

async function openPlaylist(token, args) {
  if (!args.playlist) {
    return api(token, '/me/playlists', { method: 'POST', body: JSON.stringify(metadataFrom(args, { isNew: true })) })
  }

  const id = extractId(args.playlist, 'playlist')
  if (!id) throw new Error(`Invalid playlist: ${args.playlist}`)

  const playlist = await api(token, `/playlists/${id}?fields=name,external_urls`)
  const metadata = metadataFrom(args, { isNew: false })
  if (Object.keys(metadata).length) await api(token, `/playlists/${id}`, { method: 'PUT', body: JSON.stringify(metadata) })

  return { ...playlist, id }
}

// PUT replaces the whole playlist, the remaining chunks are appended in order.
async function replaceItems(token, playlistId, uris) {
  let first = true

  for (const chunk of chunks(uris, PAGE_SIZE)) {
    await api(token, `/playlists/${playlistId}/items`, {
      method: first ? 'PUT' : 'POST',
      body: JSON.stringify({ uris: chunk }),
    })
    first = false
  }
}

// Names come from the playlist itself: one request per 100 tracks instead of one per track.
async function readItemLabels(token, playlistId) {
  const labels = []

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await api(token, `/playlists/${playlistId}/items?limit=${PAGE_SIZE}&offset=${offset}`)
    labels.push(...page.items.map((entry) => trackLabel(entry.item ?? entry.track)))
    if (!page.next) return labels
  }
}

/* ---------------------------------- main ---------------------------------- */

const HELP = `
create-playlist — build a Spotify playlist from a list of tracks, in file order.

  create-playlist --name "My Playlist" --file tracks.txt [--desc "..."] [--public]
  create-playlist --playlist <id|url> --file tracks.txt

Options
  --name <text>       name of the playlist to create (or rename to, with --playlist)
  --file <path>       list of tracks, one per line; "-" reads standard input
  --playlist <id|url> replace the contents of an existing playlist instead of creating one
  --desc <text>       playlist description
  --public            make the playlist public (default: private)
  --client-id <id>    Spotify client id (default: $SPOTIFY_CLIENT_ID or the .env next to the script)
  --help              show this

Each line of the file may be a Spotify URI, URL, bare id, or "Artist - Song" to search for.
Blank lines and lines starting with # are ignored.

First run opens the browser to authorize; the token is cached in
${TOKEN_FILE.replace(homedir(), '~')} and refreshed automatically.

Setup: https://github.com/anddreluis2/spotify-playlist#setup
`

const SETUP_HINT = `No Spotify client id found.

  1. Create an app at https://developer.spotify.com/dashboard
     - APIs used: Web API
     - Redirect URI: ${REDIRECT_URI.href}
     - Settings > User Management: add the account you will authorize with
  2. Pass it with --client-id, export SPOTIFY_CLIENT_ID, or write a .env file:

     SPOTIFY_CLIENT_ID=your_client_id

No client secret is needed: the login uses Authorization Code + PKCE.`

async function readLines(path) {
  // fs/promises cannot read a file descriptor, so standard input goes through the sync API.
  const content = path === '-' ? readFileSync(0, 'utf8') : await readFile(path, 'utf8')
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

async function main() {
  await loadEnv()

  const { values: args } = parseArgs({
    options: {
      name: { type: 'string' },
      file: { type: 'string' },
      desc: { type: 'string' },
      playlist: { type: 'string' },
      public: { type: 'boolean' },
      'client-id': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (args.help) return console.log(HELP.trim())

  if (args['client-id']) process.env.SPOTIFY_CLIENT_ID = args['client-id']
  if (!process.env.SPOTIFY_CLIENT_ID) throw new Error(SETUP_HINT)
  if (!args.name && !args.playlist) throw new Error('Pass --name "Playlist name" or --playlist <id|url>.')
  if (!args.file) throw new Error('Pass --file tracks.txt (one track or URI per line), or --help.')

  const lines = await readLines(args.file)
  if (!lines.length) throw new Error(`${args.file} has no tracks.`)

  const token = await authenticate()
  const entries = await resolveLines(token, lines)
  const missing = entries.filter((entry) => !entry.id).map((entry) => entry.line)

  let ids = entries.filter((entry) => entry.id).map((entry) => entry.id)
  if (!ids.length) throw new Error('No track could be resolved; nothing was written.')

  const playlist = await openPlaylist(token, args)
  const write = () => replaceItems(token, playlist.id, ids.map((id) => `spotify:track:${id}`))

  try {
    await write()
  } catch (error) {
    if (error.status !== 400) throw error

    // The API rejects the whole request over a single bad id, so find the culprits and retry.
    const invalid = new Set(await findInvalidIds(token, ids))
    missing.push(...entries.filter((entry) => invalid.has(entry.id)).map((entry) => entry.line))
    ids = ids.filter((id) => !invalid.has(id))
    if (!ids.length) throw new Error('Every track was rejected by the API; nothing was written.')
    await write()
  }

  const labels = await readItemLabels(token, playlist.id)
  labels.forEach((label, index) => console.log(`[${index + 1}/${labels.length}] ${label}`))

  const action = args.playlist ? 'updated' : 'created'
  console.log(`\nPlaylist "${args.name ?? playlist.name}" ${action} with ${labels.length} track(s), in file order:`)
  console.log(playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`)
  if (missing.length) console.log(`\nSkipped (${missing.length}):\n- ${missing.join('\n- ')}`)
}

// A 403 here is almost never about scopes: it means the app cannot reach the endpoint at all.
const FORBIDDEN_HINT = `
A 403 from Spotify usually means the app itself is not allowed to use that endpoint:
  - the account you authorized with is not in Settings > User Management of the app, or
  - the app was created without "Web API" under APIs used.
Both are fixed at https://developer.spotify.com/dashboard`

main().catch((error) => {
  console.error(`Error: ${error.message}${error.status === 403 ? FORBIDDEN_HINT : ''}`)
  process.exit(1)
})
