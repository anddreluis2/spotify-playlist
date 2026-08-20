// Creating, opening and rewriting playlists. Order of the input is the order that is written.

import { api } from './api.ts'
import { PAGE_SIZE } from './config.ts'
import { extractId, trackLabel } from './spotify.ts'

import type { Args, Playlist, PlaylistItemsPage } from './types.ts'

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

interface Metadata {
  name?: string
  description?: string
  public?: boolean
}

/** Only the fields the caller actually asked for, so updates do not reset untouched ones. */
function metadataFrom(args: Args, { isNew }: { isNew: boolean }): Metadata {
  return {
    ...(args.name !== undefined && { name: args.name }),
    ...(args.desc !== undefined && { description: args.desc }),
    ...((args.public !== undefined || isNew) && { public: args.public ?? false }),
  }
}

/** The playlist to write into: a new one, or an existing one with its metadata brought up to date. */
export async function openPlaylist(token: string, args: Args): Promise<Playlist> {
  if (!args.playlist) {
    const body = JSON.stringify(metadataFrom(args, { isNew: true }))
    return api<Playlist>(token, '/me/playlists', { method: 'POST', body })
  }

  const id = extractId(args.playlist, 'playlist')
  if (!id) throw new Error(`Invalid playlist: ${args.playlist}`)

  const playlist = await api<Playlist>(token, `/playlists/${id}?fields=name,external_urls`)
  const metadata = metadataFrom(args, { isNew: false })
  if (Object.keys(metadata).length) {
    await api(token, `/playlists/${id}`, { method: 'PUT', body: JSON.stringify(metadata) })
  }

  return { ...playlist, id }
}

/** PUT replaces the whole playlist; the remaining chunks are appended in order. */
export async function replaceItems(token: string, playlistId: string, uris: string[]): Promise<void> {
  let first = true

  for (const chunk of chunks(uris, PAGE_SIZE)) {
    await api(token, `/playlists/${playlistId}/items`, {
      method: first ? 'PUT' : 'POST',
      body: JSON.stringify({ uris: chunk }),
    })
    first = false
  }
}

/** Names come from the playlist itself: one request per 100 tracks instead of one per track. */
export async function readItemLabels(token: string, playlistId: string): Promise<string[]> {
  const labels: string[] = []

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await api<PlaylistItemsPage>(token, `/playlists/${playlistId}/items?limit=${PAGE_SIZE}&offset=${offset}`)
    for (const entry of page.items) {
      const track = entry.item ?? entry.track
      if (track) labels.push(trackLabel(track))
    }
    if (!page.next) return labels
  }
}
