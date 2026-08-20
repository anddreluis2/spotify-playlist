// Everything that is tuned or worked around lives here, so the rest of the code reads plainly.
//
// Spotify Web API quirks, all of which surface as a bare 403 with no message:
//   - GET /tracks?ids= (batch) is unavailable to apps in development mode; only GET /tracks/{id} works.
//   - POST /users/{id}/playlists is unavailable too; POST /me/playlists creates the same playlist.
//   - /playlists/{id}/tracks was replaced by /playlists/{id}/items on 2026-02-11.
//   - Rate limits are per endpoint. A burst of GET /tracks/{id} can earn a Retry-After of ~24h,
//     which is why track names are read back from the playlist instead of looked up one by one.

import { homedir } from 'node:os'
import { join } from 'node:path'

export const API_BASE = 'https://api.spotify.com/v1'
export const ACCOUNTS_BASE = 'https://accounts.spotify.com'

export const REDIRECT_URI = new URL('http://127.0.0.1:8888/callback')
export const SCOPES = 'playlist-modify-private playlist-modify-public playlist-read-private'
export const TOKEN_FILE = join(homedir(), '.config', 'spotify-playlist', 'token.json')
export const ENV_FILE = new URL('../.env', import.meta.url)

export const PAGE_SIZE = 100 // most items the API accepts in a single playlist request
export const MAX_RETRY_WAIT_SECONDS = 30 // above this a 429 is reported instead of waited out
