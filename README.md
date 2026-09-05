# Cross-Post Admin Panel

A tiny, no-login, local-only admin panel that posts to **Bluesky** and your
**Mastodon** instance at the same time, over plain HTTP. No accounts, no
database — just a text box, two checkboxes, and a drop zone for media.

Oversized or wrong-format photos/videos are automatically re-encoded to fit
each platform's own limits right before posting — see
[Background media editor](#background-media-editor) below.

## Contents

- [Setup](#setup)
- [Usage](#usage)
- [Background media editor](#background-media-editor)
- [Notes / things worth knowing](#notes--things-worth-knowing)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [Credits & third-party licenses](#credits--third-party-licenses)

## Setup

### 1. Get your credentials

**Bluesky**
1. Go to https://bsky.app/settings/app-passwords
2. Create an app password (not your real account password).

**Mastodon**
1. On your instance, go to **Settings → Development → New Application**.
2. Name it whatever you like, and enable both the `write:statuses` scope
   (to post) and the `write:media` scope (to upload photos/video — posting
   text-only works without it, but attaching media will fail with a 403
   "outside the authorized scopes" error if it's missing).
3. Copy the generated **access token**.

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```
BLUESKY_HANDLE=yourhandle.bsky.social
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx

MASTODON_INSTANCE_URL=https://your.instance
MASTODON_ACCESS_TOKEN=your_mastodon_access_token
```

You can leave either platform's credentials blank — the panel will just
disable that platform's checkbox until it's configured.

### 3. Run it with Docker

```bash
docker compose up -d --build
```

Then open:

```
http://localhost:8080
```

(swap `localhost` for your server's LAN IP if running on another machine on
your network — e.g. `http://192.168.1.50:8080`)

## Usage

- Type your post (500 char limit, matching both platforms' comfortable range).
- Optionally attach photos or a video — click the dropzone to pick files.
- Check/uncheck Bluesky and/or Mastodon.
- Hit **Post**. It fires to both platforms in parallel and shows per-platform
  success/failure with a link to the live post.

## Background media editor

You don't need to pre-shrink anything before uploading. If a photo or video
is over a platform's size limit, the wrong format, or (for video) too long,
the server automatically makes a **separate, tailored copy for each
platform** right before posting, instead of rejecting the upload:

- **Images** are resized/recompressed to JPEG (`mediaOptimizer.js`, via
  `sharp`) until they fit the target platform's byte limit.
- **Video** is re-encoded and, if necessary, trimmed to fit the target
  platform's byte and duration limits (`mediaOptimizer.js`, via `ffmpeg`).

Because Bluesky (≤2MB images) and Mastodon (≤10MB by default) have different
limits, the exact bytes that land on each platform can differ slightly even
from the same upload — that's expected.

Only two things are never auto-fixed, since they'd mean silently dropping
content you chose to attach:
- attaching more images than a platform allows, and
- mixing a video with images in the same post.

You'll see a heads-up in the UI next to any file that will be adjusted, but
it won't block you from posting.

## Notes / things worth knowing

- **No auth, no HTTPS.** This is intentional for personal/local use — don't
  expose port 8080 to the open internet. Keep it on your LAN or behind a VPN
  (Tailscale, WireGuard, etc.) if you want to reach it remotely.
- **Photos & video.** You can attach either up to 4 images or 1 video (never
  both — neither platform allows mixing images and video in one post). The
  limits shown adapt to **which platforms you have checked**:
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
- Network errors (bad instance URL, DNS/connectivity issues, etc.) are
  surfaced with the underlying cause rather than a bare "fetch failed" —
  check the per-platform error message in the UI for specifics.

## Troubleshooting

**Posting to Mastodon fails with `fetch failed: ETIMEDOUT ... ENETUNREACH ...`**
(status/media calls to your instance time out, but the instance loads fine
in a browser)

This is a known Node.js dual-stack connection bug, not a real block on your
instance. Node's `fetch` resolves your instance's hostname to both an IPv4
and an IPv6 address and races connections to both ("happy eyeballs"). Inside
most Docker setups there's no outbound IPv6 route at all, so the IPv6
attempt fails instantly with `ENETUNREACH` — but a bug in Node's race logic
means that fast failure doesn't reliably hand off to the IPv4 attempt in
time, so the otherwise-working IPv4 connection stalls until it also times
out ([nodejs/node#48822](https://github.com/nodejs/node/issues/48822)).

`server.js` already works around this on startup with:

```js
dns.setDefaultResultOrder('ipv4first');   // DNS returns IPv4 first
net.setDefaultAutoSelectFamily(false);    // ...and don't race IPv6 at all
```

The first line alone isn't enough — it only changes which address DNS
*returns* first, it doesn't stop Node from racing both families once it has
them. The second line is what actually disables the race, so Node just
connects over IPv4 directly. If you're running an older copy of this
project without the second line, updating `server.js` and rebuilding
(`docker compose up -d --build`) resolves it.

## Project structure

```
.
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
├── server.js
├── mediaOptimizer.js
└── public/
    └── index.html
```

## Credits & third-party licenses

This project is built on top of the following open-source software. None of
it is redistributed inside this repo — `npm install` and `apk add` (inside
the Dockerfile) pull it from its original maintainers at build time — but
per each project's license terms, here's attribution for everything doing
the actual heavy lifting, especially the photo/video re-encoding:

| Component | Used for | License | Project |
|---|---|---|---|
| [Express](https://github.com/expressjs/express) | Web server | MIT | expressjs.com |
| [Multer](https://github.com/expressjs/multer) | Multipart upload parsing | MIT | github.com/expressjs/multer |
| [image-size](https://github.com/image-size/image-size) | Reading image dimensions for Bluesky's `aspectRatio` | MIT | github.com/image-size/image-size |
| [sharp](https://github.com/lovell/sharp) | Image resizing/recompression (`mediaOptimizer.js`) | Apache-2.0 | sharp.pixelplumbing.com |
| [libvips](https://github.com/libvips/libvips) | Image processing engine used internally by sharp | LGPL-2.1-or-later | libvips.org |
| [FFmpeg](https://ffmpeg.org/) | Video re-encoding/trimming (`mediaOptimizer.js`) | LGPL-2.1-or-later, or **GPL-2.0-or-later** when built with `--enable-gpl` | ffmpeg.org |
| [x264](https://www.videolan.org/developers/x264.html) | H.264 video encoding used by FFmpeg | GPL-2.0-or-later | videolan.org |

**On the FFmpeg/x264 licensing specifically**, since it's the piece doing the
video editing: the Dockerfile installs FFmpeg via Alpine's `apk add ffmpeg`,
which is built with `--enable-gpl` and libx264 enabled. That means the
FFmpeg binary running inside this container is GPL-licensed as a whole (the
GPL is "viral" for combinations that statically or dynamically link in GPL
code, like x264). This project calls that FFmpeg binary as a separate
system process via the command line — it does not link against FFmpeg's
libraries directly — but if you redistribute a built image of this project,
you're shipping a GPL-licensed FFmpeg binary and should comply with the
GPL's source-availability terms for it (FFmpeg's own source is freely
available at [ffmpeg.org](https://ffmpeg.org/download.html)).

This section is provided for transparency and isn't legal advice — if you
plan to distribute this project commercially, it's worth getting your own
license review, particularly around the bundled FFmpeg/x264 combination.
