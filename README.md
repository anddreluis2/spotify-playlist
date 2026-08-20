# spotify-playlist

Creates a Spotify playlist from a list of tracks, or replaces the contents of an existing one,
always preserving the order of the input file.

Single file, no dependencies — plain Node.js (needs Node 22+ for `util.parseEnv`).

## Setup

1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard):
   - **APIs used**: Web API
   - **Redirect URI**: `http://127.0.0.1:8888/callback`
   - **Settings → User Management**: add your name and the e-mail of the Spotify account you will
     authorize with. Apps in development mode only work for the accounts listed there.
2. Put the client id in a `.env` next to the script (it is gitignored):

   ```
   SPOTIFY_CLIENT_ID=your_client_id
   ```

   No client secret needed — the login uses Authorization Code + PKCE.

## Usage

```bash
# create a new playlist
node create-playlist.mjs --name "My Playlist" --file tracks.txt [--desc "..."] [--public]

# replace the contents of an existing one
node create-playlist.mjs --playlist <id|url> --file tracks.txt
```

The first run opens the browser to authorize. The token is cached in
`~/.config/spotify-playlist/token.json` and refreshed automatically, so later runs need no login.

Each line of the input file can be:

```
spotify:track:0sKymIftfpTNp62P4oTvTY
https://open.spotify.com/track/0sKymIftfpTNp62P4oTvTY
0sKymIftfpTNp62P4oTvTY
Djavan - Oceano          # looked up through /search
# blank lines and comments are ignored
```

Lines that cannot be resolved are listed at the end and skipped; everything else is written in
file order. Passing `--playlist` replaces the whole tracklist, so the file is the source of truth.

## Notes on the Spotify API

Behaviour worked around in the script, documented here because none of it is obvious from the
error responses — every one of them fails as a bare `403` with no message:

- `GET /tracks?ids=` (batch) is unavailable to apps in development mode; only `GET /tracks/{id}` works.
- `POST /users/{id}/playlists` is unavailable too; `POST /me/playlists` creates the same playlist.
- `/playlists/{id}/tracks` was replaced by `/playlists/{id}/items` on 2026-02-11.
- Rate limits are per endpoint, and a burst of `GET /tracks/{id}` can earn a `Retry-After` of ~24h.
  That is why track names are read back from the playlist (1 request per 100 tracks) instead of
  being looked up one by one, and why a `429` asking for a long wait is reported instead of slept off.
