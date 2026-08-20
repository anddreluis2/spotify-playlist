# spotify-playlist

Build a Spotify playlist from a plain text file — one track per line, **in the order you wrote them**.
Creates a new playlist or replaces the contents of an existing one.

Single file, zero dependencies, Node 22+.

```bash
node create-playlist.mjs --name "Road trip" --file tracks.txt
```

```
[1/3] Fleetwood Mac - The Chain - 2004 Remaster
[2/3] Tom Petty and the Heartbreakers - Runnin' Down A Dream
[3/3] Steppenwolf - Born To Be Wild

Playlist "Road trip" created with 3 track(s), in file order:
https://open.spotify.com/playlist/...
```

## Why

Spotify's own import flows lose the order you carefully arranged, and every third-party site
wants your account. This is one file you can read in five minutes, running on your machine,
authorizing through your own Spotify app.

## Setup

You need a free Spotify app to get a client id. It takes about two minutes.

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → **Create app**
   - **APIs used**: check **Web API**
   - **Redirect URI**: `http://127.0.0.1:8888/callback`
2. Open the app → **Settings → User Management** → add your name and the e-mail of the Spotify
   account you will use. Apps start in development mode and only work for the accounts listed there.
3. Copy the **Client ID** and give it to the script — any one of:

   ```bash
   cp .env.example .env        # then paste the id into .env
   export SPOTIFY_CLIENT_ID=...
   node create-playlist.mjs --client-id ... [...]
   ```

There is no client secret anywhere: the login uses Authorization Code + PKCE.

The first run opens your browser to authorize. The token is cached in
`~/.config/spotify-playlist/token.json` and refreshed automatically, so it only happens once.

## Usage

```bash
# create a playlist
node create-playlist.mjs --name "My Playlist" --file tracks.txt

# make it public, with a description
node create-playlist.mjs --name "My Playlist" --file tracks.txt --public --desc "summer 2026"

# replace the contents of an existing playlist (the file becomes the source of truth)
node create-playlist.mjs --playlist https://open.spotify.com/playlist/xxx --file tracks.txt

# pipe from anywhere
grep -v '^#' favourites.txt | node create-playlist.mjs --name "Favourites" --file -

node create-playlist.mjs --help
```

Installing it as a command is optional:

```bash
npm install -g .        # then: create-playlist --name ... --file ...
```

### The track file

Any of these forms works, mixed freely — see [`tracks.example.txt`](tracks.example.txt):

```
spotify:track:0sKymIftfpTNp62P4oTvTY
https://open.spotify.com/track/1mSxbLW7fKABfeY4lGpg0E
3gdewACMIVMEWVbyb8O9sY
Djavan - Oceano          # searched on the API
# blank lines and comments are ignored
```

`Artist - Song` lines cost one search request each; ids and URLs cost nothing. Lines that cannot
be resolved are listed at the end and skipped — the rest is still written.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `403` on any call | The account you authorized is not in **User Management**, or the app was created without **Web API**. Both are fixed in the dashboard, then delete `~/.config/spotify-playlist/token.json` and run again. |
| `INVALID_CLIENT` on login | The redirect URI in the dashboard is not exactly `http://127.0.0.1:8888/callback`. |
| Browser tab hangs on "authorize" | Something else is on port 8888. Change `REDIRECT_URI` in the script and in the dashboard to match. |
| `429, retry-after <big number>` | You hit a per-endpoint rate limit. It only affects track lookups; playlist writes keep working. |

## Notes on the Spotify API

Worked around in the script, documented here because none of it is visible from the responses —
each of these fails as a bare `403` with no message:

- `GET /tracks?ids=` (batch) is unavailable to apps in development mode; only `GET /tracks/{id}` works.
- `POST /users/{id}/playlists` is unavailable too; `POST /me/playlists` creates the same playlist.
- `/playlists/{id}/tracks` was replaced by `/playlists/{id}/items` on 2026-02-11.
- Rate limits are per endpoint, and a burst of `GET /tracks/{id}` can earn a `Retry-After` of ~24h.
  That is why track names are read back from the playlist (1 request per 100 tracks) instead of
  being looked up one by one, and why a `429` asking for a long wait is reported instead of slept off.

## License

MIT
