#!/usr/bin/env node
// Create a Spotify playlist from a list of tracks, or replace the contents of an existing one,
// always preserving the order of the input file. Run with --help for the options.
//
// src/types.ts      the Spotify response shapes this tool reads
// src/config.ts     constants, and the API quirks this tool works around
// src/api.ts        the single HTTP entry point, including the 429 policy
// src/auth.ts       login (Authorization Code + PKCE) and the cached token
// src/spotify.ts    how ids are written and how a track is labelled
// src/tracks.ts     input lines -> track ids
// src/playlist.ts   creating, opening and rewriting a playlist

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'

import { authenticate, loadEnv } from './src/auth.ts'
import { REDIRECT_URI, TOKEN_FILE } from './src/config.ts'
import { openPlaylist, readItemLabels, replaceItems } from './src/playlist.ts'
import { trackUri } from './src/spotify.ts'
import { findInvalidIds, resolveLines } from './src/tracks.ts'

import type { ApiError, Args } from './src/types.ts'

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

// A 403 is almost never about scopes: it means the app cannot reach the endpoint at all.
const FORBIDDEN_HINT = `
A 403 from Spotify usually means the app itself is not allowed to use that endpoint:
  - the account you authorized with is not in Settings > User Management of the app, or
  - the app was created without "Web API" under APIs used.
Both are fixed at https://developer.spotify.com/dashboard`

async function readLines(path: string): Promise<string[]> {
  // fs/promises cannot read a file descriptor, so standard input goes through the sync API.
  const content = path === '-' ? readFileSync(0, 'utf8') : await readFile(path, 'utf8')

  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

function readArgs(): Args {
  const { values } = parseArgs({
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

  if (values.help) return values
  if (values['client-id']) process.env.SPOTIFY_CLIENT_ID = values['client-id']

  if (!process.env.SPOTIFY_CLIENT_ID) throw new Error(SETUP_HINT)
  if (!values.name && !values.playlist) throw new Error('Pass --name "Playlist name" or --playlist <id|url>.')
  if (!values.file) throw new Error('Pass --file tracks.txt (one track or URI per line), or --help.')

  return values
}

async function main(): Promise<void> {
  await loadEnv()
  const args = readArgs()
  if (args.help) return console.log(HELP.trim())

  const lines = await readLines(args.file!)
  if (!lines.length) throw new Error(`${args.file} has no tracks.`)

  const token = await authenticate()
  const entries = await resolveLines(token, lines)
  const skipped = entries.filter((entry) => !entry.id).map((entry) => entry.line)

  let ids = entries.flatMap((entry) => (entry.id ? [entry.id] : []))
  if (!ids.length) throw new Error('No track could be resolved; nothing was written.')

  const playlist = await openPlaylist(token, args)
  const write = () => replaceItems(token, playlist.id, ids.map(trackUri))

  try {
    await write()
  } catch (error) {
    if ((error as ApiError).status !== 400) throw error

    // The API rejects the whole request over a single bad id, so find the culprits and retry.
    const invalid = new Set(await findInvalidIds(token, ids))
    skipped.push(...entries.filter((entry) => entry.id && invalid.has(entry.id)).map((entry) => entry.line))
    ids = ids.filter((id) => !invalid.has(id))
    if (!ids.length) throw new Error('Every track was rejected by the API; nothing was written.')
    await write()
  }

  const labels = await readItemLabels(token, playlist.id)
  labels.forEach((label, index) => console.log(`[${index + 1}/${labels.length}] ${label}`))

  const action = args.playlist ? 'updated' : 'created'
  console.log(`\nPlaylist "${args.name ?? playlist.name}" ${action} with ${labels.length} track(s), in file order:`)
  console.log(playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`)
  if (skipped.length) console.log(`\nSkipped (${skipped.length}):\n- ${skipped.join('\n- ')}`)
}

main().catch((error: ApiError) => {
  console.error(`Error: ${error.message}${error.status === 403 ? FORBIDDEN_HINT : ''}`)
  process.exit(1)
})
