// Shapes of Spotify data: how ids are written, and how a track is shown to a human.

import type { Track } from './types.ts'

/** Accepts a bare id, "spotify:<kind>:ID" or a Spotify URL, and returns the id. */
export function extractId(value: string, kind: 'track' | 'playlist'): string | null {
  const patterns = [
    /^([A-Za-z0-9]{22})$/,
    new RegExp(`^spotify:${kind}:([A-Za-z0-9]{22})$`),
    new RegExp(`open\\.spotify\\.com/(?:intl-\\w+/)?${kind}/([A-Za-z0-9]{22})`),
  ]

  for (const pattern of patterns) {
    const match = value.match(pattern)
    if (match) return match[1]!
  }
  return null
}

export const trackUri = (id: string): string => `spotify:track:${id}`

export const trackLabel = (track: Track): string =>
  `${track.artists.map((artist) => artist.name).join(', ')} - ${track.name}`
