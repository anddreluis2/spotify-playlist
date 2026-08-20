// Turning the lines of the input file into Spotify track ids.

import { api } from './api.ts'
import { extractId, trackLabel } from './spotify.ts'

import type { ApiError, Entry, SearchResponse, Track } from './types.ts'

/** "Artist - Song" becomes a fielded query; a line without a separator has no structured form. */
function buildQuery(line: string): string | null {
  const parts = line.split(/\s+[-–—]\s+/)
  if (parts.length < 2) return null

  const [artist, ...rest] = parts
  return `track:${rest.join(' - ')} artist:${artist}`
}

async function searchTrack(token: string, line: string): Promise<Track | null> {
  for (const query of [buildQuery(line), line]) {
    if (!query) continue

    const params = new URLSearchParams({ q: query, type: 'track', limit: '1' })
    const result = await api<SearchResponse>(token, `/search?${params}`)
    if (result.tracks.items[0]) return result.tracks.items[0]
  }
  return null
}

/** One entry per input line, in order: an id when the track is known, null when it is not. */
export async function resolveLines(token: string, lines: string[]): Promise<Entry[]> {
  const entries: Entry[] = []

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

/** Only used to explain a rejected write: one request per id, so never on the happy path. */
export async function findInvalidIds(token: string, ids: string[]): Promise<string[]> {
  const invalid: string[] = []

  for (const id of ids) {
    try {
      await api<Track>(token, `/tracks/${id}`, { maxRetryWait: 0 })
    } catch (error) {
      const status = (error as ApiError).status
      if (status !== 404 && status !== 400) throw error
      invalid.push(id)
    }
  }

  return invalid
}
