# Cross-Post Admin Panel

A tiny, no-login, local-only admin panel that posts to **Bluesky** and your
**Mastodon** instance (`mastodon.social`) at the same time, over plain HTTP.
No accounts, no database — just one text box and two checkboxes.

## 1. Get your credentials

**Bluesky**
1. Go to https://bsky.app/settings/app-passwords
2. Create an app password (not your real account password).

**Mastodon**
1. On `mastodon.social`, go to **Settings → Development → New Application**.
2. Name it whatever you like, and enable both the `write:statuses` scope
   (to post) and the `write:media` scope (to upload photos/video — posting
   text-only works without it, but attaching media will fail with a 403
   "outside the authorized scopes" error if it's missing).
3. Copy the generated **access token**.

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```
BLUESKY_HANDLE=yourhandle.bsky.social
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx

MASTODON_INSTANCE_URL=https://mastodon.social
MASTODON_ACCESS_TOKEN=your_mastodon_access_token
```

You can leave either platform's credentials blank — the panel will just
disable that platform's checkbox until it's configured.

## 3. Run it with Docker

```bash
docker compose up -d --build
```

Then open:

```
http://localhost:8080
```

(swap `localhost` for your server's LAN IP if running on another machine
on your network — e.g. `http://192.168.1.50:8080`)

## 4. Use it

- Type your post (500 char limit, matching both platforms' comfortable range).
- Optionally attach photos or a video — click the dropzone to pick files.
- Check/uncheck Bluesky and/or Mastodon.
- Hit **Post**. It fires to both platforms in parallel and shows per-platform
  success/failure with a link to the live post.

## Notes / things worth knowing

- **No auth, no HTTPS.** This is intentional per your "personal local" ask —
  don't expose port 8080 to the open internet. Keep it on your LAN or behind
  a VPN (Tailscale, WireGuard, etc.) if you want to reach it remotely.
- **Photos & video.** You can attach either up to 4 images or 1 video (never
  both — neither platform allows mixing images and video in one post). The
  size/format limits shown and enforced adapt to **which platforms you have
  checked** — if you uncheck Bluesky, the limit relaxes to whatever your
  Mastodon instance itself allows (fetched live from `GET /api/v2/instance`),
  and vice versa. With both checked, whichever platform is stricter wins, so
  a single upload posts cleanly to both:
  - **Bluesky**: up to 4 images, ≤2MB each, JPEG/PNG/WebP/GIF — or 1 video,
    ≤100MB, up to ~3 minutes, MP4.
  - **Mastodon**: limits come from your instance's own configuration
    (vanilla defaults: 4 images ≤10MB each, 1 video ≤40MB) — some instances
    allow much more.
  - Alt text is optional but recommended per attachment, and is sent to
    both platforms.
  - Bluesky's video processing only starts *after* the post is submitted,
    so a freshly posted video may take a few seconds to appear playable.
- **Bluesky session**: the server logs in fresh on every post using the app
  password rather than caching a session token — simplest and most reliable
  for occasional personal posting.
- Character limit is capped at 500 to fit Mastodon's default limit; Bluesky's
  limit is 300 graphemes, so very long posts may still get rejected by
  Bluesky specifically — you'll see that in the per-platform result if so.

## Project structure

```
.
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
├── server.js
└── public/
    └── index.html
```

## Dependencies

Added on top of `express`:
- `multer` — parses the multipart form upload for photos/video (in-memory,
  never written to disk).
- `image-size` — reads image dimensions so Bluesky posts get a correct
  `aspectRatio` on the embed.
