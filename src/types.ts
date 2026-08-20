// Shapes of the Spotify responses this tool touches — only the fields actually read.

export interface Artist {
  name: string
}

export interface Track {
  id: string
  uri: string
  name: string
  artists: Artist[]
}

export interface Playlist {
  id: string
  name: string
  external_urls?: { spotify: string }
}

export interface PlaylistItemsPage {
  /** Named `item` since 2026-02-11; `track` is the pre-migration name. */
  items: Array<{ item?: Track; track?: Track }>
  next: string | null
}

export interface SearchResponse {
  tracks: { items: Track[] }
}

export interface StoredToken {
  access_token: string
  refresh_token?: string
  token_type: string
  expires_in: number
  /** Added by this tool: absolute expiry, in epoch milliseconds. */
  expires_at: number
}

/** Errors thrown by `api()` carry the HTTP status so callers can branch on it. */
export interface ApiError extends Error {
  status?: number
}

/** One input line, paired with the track it resolved to (or null when unresolved). */
export interface Entry {
  line: string
  id: string | null
  label?: string | null
}

export interface Args {
  name?: string
  file?: string
  desc?: string
  playlist?: string
  public?: boolean
  'client-id'?: string
  help?: boolean
}
