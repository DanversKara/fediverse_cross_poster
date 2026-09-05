const dns = require('dns');
const net = require('net');
const express = require('express');
const path = require('path');
const multer = require('multer');
const { imageSize } = require('image-size');
const { optimizeImageForLimits, optimizeVideoForLimits } = require('./mediaOptimizer');

// Node (from v18+) tries a host's IPv4 and IPv6 addresses in parallel
// ("happy eyeballs") and picks whichever connects first. Inside a lot of
// Docker setups there's no real outbound IPv6 route — every IPv6 attempt
// fails/times out immediately, and a known Node bug means that fast failure
// doesn't reliably trigger the IPv4 fallback in time, so the otherwise-fine
// IPv4 connection stalls until it also times out (nodejs/node#48822).
//
// dns.setDefaultResultOrder only changes which address DNS returns first —
// it does NOT stop Node from racing both families. The actual fix is to
// disable the race entirely so Node just uses the first resolved address.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;

// Node's fetch throws a bare "fetch failed" TypeError for any network-level
// failure (DNS lookup, connection refused, TLS handshake, timeout, etc.) —
// the actually-useful reason lives one level down in `error.cause`, and for
// dual-stack connection failures `cause` is itself an AggregateError whose
// real per-address errors are hiding in `cause.errors` — one level deeper
// still. This unwraps all of that instead of dropping it.
async function fetchWithContext(url, options) {
  try {
    return await fetch(url, options);
  } catch (e) {
    let detail = e.message;
    const cause = e.cause;
    if (cause) {
      if (Array.isArray(cause.errors)) {
        // AggregateError from a dual-stack (IPv4 + IPv6) connect attempt —
        // one sub-error per address it tried.
        const attempts = cause.errors.map((err) => {
          const addr = err.address ? `${err.address}:${err.port || ''}` : '';
          return `${err.code || err.message}${addr ? ` (${addr})` : ''}`;
        });
        detail += `: ${attempts.join(', ')}`;
      } else {
        detail += `: ${cause.code || ''} ${cause.message || cause}`.trim();
      }
    }
    throw new Error(`Request to ${url} failed: ${detail}`);
  }
}

const BLUESKY_HANDLE = process.env.BLUESKY_HANDLE || '';
const BLUESKY_APP_PASSWORD = process.env.BLUESKY_APP_PASSWORD || '';
const BLUESKY_SERVICE = process.env.BLUESKY_SERVICE || 'https://bsky.social';
// Bluesky video goes through a dedicated transcoding service, not the
// regular PDS blob endpoint used for images.
const BLUESKY_VIDEO_SERVICE = 'https://video.bsky.app';

const MASTODON_INSTANCE_URL = (process.env.MASTODON_INSTANCE_URL || 'https://social.chiefgyk3d.com').replace(/\/+$/, '');
const MASTODON_ACCESS_TOKEN = process.env.MASTODON_ACCESS_TOKEN || '';

// ---- Media constraints ----
// Bluesky limits are fixed by the AT Protocol lexicon / current Bluesky video service.
// Sources: app.bsky.embed.images (maxSize 2,000,000 bytes, maxLength 4) and the
// Bluesky video announcement (100MB, 3min, mp4/mpeg/webm/mov, one video OR up to 4 images).
const BLUESKY_LIMITS = {
  maxImages: 4,
  imageMaxBytes: 2_000_000, // 2 MB
  imageMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  // Not in the lexicon itself, but the Bluesky app/CDN caps rendered image
  // resolution at 4000px on the longest side — originals bigger than that
  // (common with modern phone "HDR"/high-res camera modes) get silently
  // stuck on a never-finishing loading spinner in the app instead of a
  // clean error.
  imageMaxDimension: 4000,
  videoMaxBytes: 100_000_000, // 100 MB
  videoMaxDurationSec: 180, // 3 minutes (not verified server-side, no ffprobe available)
  videoMimeTypes: ['video/mp4', 'video/mpeg', 'video/webm', 'video/quicktime'],
  // AT Protocol's app.bsky.feed.post lexicon caps text at 300 *graphemes*
  // (not JS string length / UTF-16 units) — this is what was previously
  // missing, which is why a 414-character post that looked fine against a
  // hardcoded "500" client-side counter got rejected server-side.
  textLimit: 300,
};

// Mastodon limits vary per-instance. We ask the instance for its actual configured
// limits (GET /api/v2/instance) and fall back to vanilla Mastodon defaults if that
// fails or the instance is older and doesn't expose it.
const MASTODON_DEFAULT_LIMITS = {
  maxImages: 4, // vanilla Mastodon's built-in cap on non-poll attachments
  imageMaxBytes: 10_000_000, // 10 MB (default Mastodon config)
  // Vanilla Mastodon's MAX_MATRIX_LIMIT — total width*height pixels. This is
  // what actually rejected the 8192x6144 (50.3MP) photo: it's well under the
  // 10MB byte cap but way over the pixel-count cap, which byte size alone
  // doesn't catch.
  imageMaxPixels: 33_177_600,
  videoMaxBytes: 40_000_000, // 40 MB (default Mastodon config)
  imageMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif'],
  videoMimeTypes: ['video/webm', 'video/mp4', 'video/quicktime', 'video/ogg'],
  videoMaxDurationSec: null, // not exposed by the Mastodon instance API
  textLimit: 500, // vanilla Mastodon's default status character limit
};

let mastodonLimitsCache = { value: null, fetchedAt: 0 };
const MASTODON_LIMITS_TTL_MS = 5 * 60 * 1000;

async function getMastodonLimits() {
  if (!MASTODON_INSTANCE_URL) return MASTODON_DEFAULT_LIMITS;

  const now = Date.now();
  if (mastodonLimitsCache.value && now - mastodonLimitsCache.fetchedAt < MASTODON_LIMITS_TTL_MS) {
    return mastodonLimitsCache.value;
  }

  try {
    const res = await fetchWithContext(`${MASTODON_INSTANCE_URL}/api/v2/instance`);
    if (!res.ok) throw new Error(`instance config fetch failed: ${res.status}`);
    const data = await res.json();
    const ma = data?.configuration?.media_attachments;
    const st = data?.configuration?.statuses;
    const mimeTypes = ma?.supported_mime_types || MASTODON_DEFAULT_LIMITS.imageMimeTypes.concat(MASTODON_DEFAULT_LIMITS.videoMimeTypes);
    const limits = {
      maxImages: st?.max_media_attachments || MASTODON_DEFAULT_LIMITS.maxImages,
      imageMaxBytes: ma?.image_size_limit || MASTODON_DEFAULT_LIMITS.imageMaxBytes,
      imageMaxPixels: ma?.image_matrix_limit || MASTODON_DEFAULT_LIMITS.imageMaxPixels,
      videoMaxBytes: ma?.video_size_limit || MASTODON_DEFAULT_LIMITS.videoMaxBytes,
      imageMimeTypes: mimeTypes.filter((m) => m.startsWith('image/')),
      videoMimeTypes: mimeTypes.filter((m) => m.startsWith('video/')),
      videoMaxDurationSec: null,
      textLimit: st?.max_characters || MASTODON_DEFAULT_LIMITS.textLimit,
    };
    mastodonLimitsCache = { value: limits, fetchedAt: now };
    return limits;
  } catch (e) {
    // Instance unreachable or too old to expose config — fall back to safe defaults
    // rather than blocking the whole feature.
    return MASTODON_DEFAULT_LIMITS;
  }
}

// Combine limits for exactly the platforms the person actually has selected.
// If they've unchecked Bluesky, a file only needs to satisfy Mastodon's limits
// (and vice versa) — only intersect across platforms that are both selected
// AND configured, since an unconfigured/unselected platform never receives the file.
async function getLimitsForTargets(targets) {
  const wantBluesky = targets.includes('bluesky') && Boolean(BLUESKY_HANDLE && BLUESKY_APP_PASSWORD);
  const wantMastodon = targets.includes('mastodon') && Boolean(MASTODON_ACCESS_TOKEN);

  const active = [];
  if (wantBluesky) active.push(BLUESKY_LIMITS);
  if (wantMastodon) active.push(await getMastodonLimits());

  if (active.length === 0) {
    // Nothing configured/selected — fall back to Bluesky's shape so the caller
    // still gets sane numbers (postToX will raise the real "not configured" error).
    active.push(BLUESKY_LIMITS);
  }

  const intersect = (lists) => lists.reduce((acc, l) => (acc ? acc.filter((m) => l.includes(m)) : l), null);
  const minOf = (nums) => {
    const defined = nums.filter((n) => n !== null && n !== undefined);
    return defined.length ? Math.min(...defined) : null;
  };

  return {
    maxImages: minOf(active.map((l) => l.maxImages)),
    imageMaxBytes: minOf(active.map((l) => l.imageMaxBytes)),
    imageMaxDimension: minOf(active.map((l) => l.imageMaxDimension)),
    imageMaxPixels: minOf(active.map((l) => l.imageMaxPixels)),
    imageMimeTypes: intersect(active.map((l) => l.imageMimeTypes)),
    videoMaxBytes: minOf(active.map((l) => l.videoMaxBytes)),
    videoMaxDurationSec: minOf(active.map((l) => l.videoMaxDurationSec)),
    videoMimeTypes: intersect(active.map((l) => l.videoMimeTypes)),
    textLimit: minOf(active.map((l) => l.textLimit)),
  };
}

// ---- Grapheme-accurate text splitting (for long posts / threads) ----
// Bluesky (and most Mastodon instances) count post length in *graphemes*,
// not JS string length/UTF-16 units, so a couple of emoji or combined
// characters can silently blow the real limit even when `.length` looks
// fine. Intl.Segmenter gives us the same notion of "one visible character"
// that the platforms use.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemeLength(str) {
  return [...graphemeSegmenter.segment(str)].length;
}

function sliceGraphemes(str, n) {
  const arr = [...graphemeSegmenter.segment(str)].map((s) => s.segment);
  return arr.slice(0, n).join('');
}

// Greedy word-wrap into chunks of at most `limit` graphemes, respecting
// existing line breaks and word boundaries where possible. Falls back to a
// hard grapheme-safe cut only for single words/tokens longer than the limit.
function greedySplit(text, limit) {
  const paragraphs = text.split('\n');
  const chunks = [];
  let current = '';
  const pushCurrent = () => {
    if (current.length) chunks.push(current);
    current = '';
  };

  paragraphs.forEach((para, pIdx) => {
    const words = para.split(' ');
    words.forEach((word) => {
      const candidate = current ? `${current} ${word}` : word;
      if (graphemeLength(candidate) <= limit) {
        current = candidate;
      } else {
        pushCurrent();
        if (graphemeLength(word) <= limit) {
          current = word;
        } else {
          let w = word;
          while (graphemeLength(w) > limit) {
            const seg = sliceGraphemes(w, limit);
            chunks.push(seg);
            w = w.slice(seg.length);
          }
          current = w;
        }
      }
    });
    if (pIdx < paragraphs.length - 1) {
      const withBreak = `${current}\n`;
      if (current && graphemeLength(withBreak) <= limit) {
        current = withBreak;
      } else {
        pushCurrent();
      }
    }
  });
  pushCurrent();
  return chunks.map((c) => c.trim()).filter(Boolean);
}

// Splits `text` into a thread of posts, each within `limit` graphemes,
// appending a "i/total" counter to every post (e.g. "…\n\n1/3"). If the text
// already fits, returns it unchanged as a single-element array.
function splitIntoThread(text, limit) {
  if (graphemeLength(text) <= limit) return [text];

  const counterLen = (i, total) => graphemeLength(`\n\n${i}/${total}`);

  // Two passes: first estimate the part count with a safe reserve, then
  // re-split using the exact reserve that count implies (digit width can
  // change the reserve, e.g. "9/9" vs "10/10").
  let reserve = 6;
  let chunks = greedySplit(text, limit - reserve);
  let total = chunks.length;
  let exactReserve = counterLen(total, total);
  if (exactReserve !== reserve) {
    chunks = greedySplit(text, limit - exactReserve);
    total = chunks.length;
  }

  return chunks.map((c, i) => `${c}\n\n${i + 1}/${total}`);
}

// Validate the uploaded files' basic shape against the rules of whichever
// platforms are actually selected for this post. Returns
// { images: [file...], video: file|null }. Throws with a user-facing message
// on violations that a re-encode can't fix (wrong file category entirely, or
// too many files). Format and byte-size limits are NOT enforced here — the
// background editor (optimizeMediaForTarget, below) brings each file into
// spec for each target platform right before it's sent, instead of rejecting
// the upload outright.
async function validateMedia(files, targets) {
  if (!files || files.length === 0) return { images: [], video: null };

  const limits = await getLimitsForTargets(targets);
  const platformNote = targets.length > 1 ? 'both selected platforms' : `${targets[0]}`;

  const images = files.filter((f) => f.mimetype.startsWith('image/'));
  const videos = files.filter((f) => f.mimetype.startsWith('video/'));
  const other = files.filter((f) => !f.mimetype.startsWith('image/') && !f.mimetype.startsWith('video/'));

  if (other.length > 0) {
    throw new Error(`Unsupported file type: ${other[0].originalname} (${other[0].mimetype}).`);
  }

  // Neither platform allows mixing a video with images in the same post.
  if (images.length > 0 && videos.length > 0) {
    throw new Error('You can attach either images or one video, not both, in a single post (Bluesky and Mastodon both disallow mixing).');
  }

  if (videos.length > 1) {
    throw new Error('Only one video is allowed per post.');
  }

  if (videos.length === 1) {
    return { images: [], video: videos[0] };
  }

  // The editor re-encodes/shrinks files, but it won't silently drop photos
  // you chose to attach — too many images is still a hard stop.
  if (images.length > limits.maxImages) {
    throw new Error(`Up to ${limits.maxImages} images are allowed per post on ${platformNote}.`);
  }

  return { images, video: null };
}

// Runs the background editor over each attached file so it fits ONE target
// platform's real limits — resizing/recompressing images, and
// re-encoding/trimming video as needed. Called once per selected platform
// (with that platform's own limits) so Bluesky and Mastodon each get a copy
// tailored to their own requirements, even when those requirements differ.
// Files that already fit are passed through untouched (see the fast paths in
// mediaOptimizer.js), so this is cheap when no editing is actually needed.
async function optimizeMediaForTarget(media, limits) {
  if (media.video) {
    const optimized = await optimizeVideoForLimits(media.video.buffer, media.video.mimetype, media.video.originalname, limits);
    return {
      images: [],
      video: { ...media.video, buffer: optimized.buffer, mimetype: optimized.mimetype, size: optimized.buffer.length },
    };
  }

  if (media.images.length > 0) {
    const images = await Promise.all(media.images.map(async (img) => {
      const optimized = await optimizeImageForLimits(img.buffer, img.mimetype, limits);
      return { ...img, buffer: optimized.buffer, mimetype: optimized.mimetype, size: optimized.buffer.length };
    }));
    return { images, video: null };
  }

  return media;
}

function safeAspectRatio(buffer) {
  try {
    const dims = imageSize(buffer);
    if (dims?.width && dims?.height) {
      return { width: dims.width, height: dims.height };
    }
  } catch (e) {
    // Not fatal — aspectRatio is optional on both platforms' embeds.
  }
  return undefined;
}

// ---- Bluesky (AT Protocol) ----
async function blueskyLogin() {
  const sessionRes = await fetchWithContext(`${BLUESKY_SERVICE}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: BLUESKY_HANDLE, password: BLUESKY_APP_PASSWORD })
  });
  if (!sessionRes.ok) {
    const err = await sessionRes.text();
    throw new Error(`Bluesky login failed: ${sessionRes.status} ${err}`);
  }
  return sessionRes.json();
}

async function blueskyUploadBlob(session, file) {
  const res = await fetchWithContext(`${BLUESKY_SERVICE}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: {
      'Content-Type': file.mimetype,
      Authorization: `Bearer ${session.accessJwt}`
    },
    body: file.buffer
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bluesky media upload failed for ${file.originalname}: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.blob;
}

// Requests a short-lived, scoped token the video service can use to write
// the processed video blob into the user's own PDS repo on their behalf.
async function blueskyGetServiceAuth(session, aud, lxm) {
  const url = new URL(`${BLUESKY_SERVICE}/xrpc/com.atproto.server.getServiceAuth`);
  url.searchParams.set('aud', aud);
  url.searchParams.set('lxm', lxm);
  url.searchParams.set('exp', String(Math.floor(Date.now() / 1000) + 60 * 30)); // 30 min

  const res = await fetchWithContext(url.toString(), {
    headers: { Authorization: `Bearer ${session.accessJwt}` }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bluesky service-auth request failed: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.token;
}

// Pulls the hostname of the account's *actual* PDS out of a DID document's
// service list (the entry with id "#atproto_pds").
function extractPdsHost(didDoc) {
  if (!didDoc || !Array.isArray(didDoc.service)) return null;
  const svc = didDoc.service.find(
    (s) => s && (s.id === '#atproto_pds' || (typeof s.id === 'string' && s.id.endsWith('#atproto_pds')))
  );
  if (!svc || !svc.serviceEndpoint) return null;
  try {
    return new URL(svc.serviceEndpoint).host;
  } catch (e) {
    return null;
  }
}

// Bluesky accounts don't necessarily live on the server you authenticated
// against — bsky.social is an "entryway" that proxies auth/API calls for
// accounts actually hosted on many different PDS hosts (e.g.
// morel.us-east.host.bsky.network). The video service's scoped-token
// audience has to be the DID of that *real* PDS, not the entryway, or you
// get "invalid token audience" back. This resolves it from the session's
// DID document, with a couple of fallbacks for older/self-hosted servers
// that don't include one on createSession.
async function blueskyGetPdsHost(session) {
  const fromSession = extractPdsHost(session.didDoc);
  if (fromSession) return fromSession;

  try {
    const res = await fetchWithContext(
      `${BLUESKY_SERVICE}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(session.did)}`,
      { headers: { Authorization: `Bearer ${session.accessJwt}` } }
    );
    if (res.ok) {
      const data = await res.json();
      const fromDescribe = extractPdsHost(data.didDoc);
      if (fromDescribe) return fromDescribe;
    }
  } catch (e) {
    // fall through to the last-resort default below
  }

  // Last resort: assume BLUESKY_SERVICE itself is the PDS. True for
  // single-account self-hosted PDS setups, just not for bsky.social.
  return new URL(BLUESKY_SERVICE).host;
}

// Uploads a video the *correct* way for Bluesky: through the dedicated
// video.bsky.app transcoding service, then polling until it finishes and
// hands back a blob reference.
//
// The old code path (uploading video via the plain com.atproto.repo.
// uploadBlob endpoint, same as images) is technically accepted by the PDS,
// but the video only starts transcoding once the post is already live —
// so anyone who opens the post in that window sees "Video not found"
// (this is a known, documented gotcha, not a fluke of any particular file).
// Going through video.bsky.app first means the video is fully processed
// *before* we ever create the post.
async function blueskyUploadVideo(session, file) {
  const pdsHost = await blueskyGetPdsHost(session);
  const aud = `did:web:${pdsHost}`;
  const token = await blueskyGetServiceAuth(session, aud, 'com.atproto.repo.uploadBlob');

  const uploadUrl = new URL(`${BLUESKY_VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo`);
  uploadUrl.searchParams.set('did', session.did);
  uploadUrl.searchParams.set('name', file.originalname || 'video.mp4');

  const uploadRes = await fetchWithContext(uploadUrl.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': file.mimetype,
      'Content-Length': String(file.buffer.length)
    },
    body: file.buffer
  });

  // A 409 here means this exact video was already uploaded — the job
  // status is still usable, just keep going instead of treating it as a
  // hard failure.
  if (!uploadRes.ok && uploadRes.status !== 409) {
    const err = await uploadRes.text();
    throw new Error(`Bluesky video upload failed: ${uploadRes.status} ${err}`);
  }

  let jobStatus = await uploadRes.json();

  // Poll app.bsky.video.getJobStatus until the video is fully transcoded
  // (or fails) — this is what guarantees the video actually exists by the
  // time we create the post referencing it. Video processing commonly
  // takes anywhere from a few seconds to a couple of minutes.
  const maxAttempts = 90; // ~7.5 minutes at 5s intervals
  let attempts = 0;
  while (!jobStatus.blob) {
    if (jobStatus.state === 'JOB_STATE_FAILED') {
      throw new Error(`Bluesky video processing failed: ${jobStatus.error || jobStatus.message || 'unknown error'}`);
    }
    if (attempts >= maxAttempts) {
      throw new Error('Bluesky video processing timed out — try a shorter/smaller video.');
    }
    await new Promise((r) => setTimeout(r, 5000));

    const statusUrl = new URL(`${BLUESKY_VIDEO_SERVICE}/xrpc/app.bsky.video.getJobStatus`);
    statusUrl.searchParams.set('jobId', jobStatus.jobId);
    const statusRes = await fetchWithContext(statusUrl.toString());
    if (!statusRes.ok) {
      const err = await statusRes.text();
      throw new Error(`Bluesky video status check failed: ${statusRes.status} ${err}`);
    }
    const data = await statusRes.json();
    jobStatus = data.jobStatus;
    attempts++;
  }

  return jobStatus.blob;
}

// Turns an at:// record URI into a clickable bsky.app web link.
function blueskyPostUrlFromUri(uri) {
  const m = /^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri || '');
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : undefined;
}

// Posts `parts` (one or more strings, each already within Bluesky's 300
// grapheme limit) as a single connected thread: part 2+ reply to the
// previous post, and all of them share the same thread root. Media (if any)
// is attached only to the first post, matching how threads normally work.
async function postToBluesky(parts, media, altTexts) {
  if (!BLUESKY_HANDLE || !BLUESKY_APP_PASSWORD) {
    throw new Error('Bluesky credentials not configured (BLUESKY_HANDLE / BLUESKY_APP_PASSWORD).');
  }

  const session = await blueskyLogin();

  let root = null;
  let parent = null;
  const posts = [];

  for (let i = 0; i < parts.length; i++) {
    const record = {
      $type: 'app.bsky.feed.post',
      text: parts[i],
      createdAt: new Date().toISOString()
    };

    if (i === 0 && media.video) {
      const blob = await blueskyUploadVideo(session, media.video);
      record.embed = {
        $type: 'app.bsky.embed.video',
        video: blob,
        alt: (altTexts && altTexts[0]) || undefined,
      };
    } else if (i === 0 && media.images.length > 0) {
      const images = [];
      for (let j = 0; j < media.images.length; j++) {
        const file = media.images[j];
        const blob = await blueskyUploadBlob(session, file);
        images.push({
          image: blob,
          alt: (altTexts && altTexts[j]) || '',
          aspectRatio: safeAspectRatio(file.buffer),
        });
      }
      record.embed = { $type: 'app.bsky.embed.images', images };
    }

    if (parent) {
      record.reply = { root, parent };
    }

    const postRes = await fetchWithContext(`${BLUESKY_SERVICE}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.accessJwt}`
      },
      body: JSON.stringify({
        repo: session.did,
        collection: 'app.bsky.feed.post',
        record
      })
    });

    if (!postRes.ok) {
      const err = await postRes.text();
      throw new Error(`Bluesky post ${i + 1}/${parts.length} failed: ${postRes.status} ${err}`);
    }

    const data = await postRes.json();
    const ref = { uri: data.uri, cid: data.cid };
    if (!root) root = ref;
    parent = ref;
    posts.push(ref);
  }

  const thread = posts.map((p) => ({ uri: p.uri, cid: p.cid, url: blueskyPostUrlFromUri(p.uri) }));
  return { uri: posts[0].uri, cid: posts[0].cid, url: thread[0].url, thread };
}

// ---- Mastodon ----
async function mastodonUploadMedia(file, description) {
  const form = new FormData();
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
  if (description) form.append('description', description);

  const res = await fetchWithContext(`${MASTODON_INSTANCE_URL}/api/v2/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MASTODON_ACCESS_TOKEN}` },
    body: form
  });

  if (!res.ok && res.status !== 202) {
    const err = await res.text();
    throw new Error(`Mastodon media upload failed for ${file.originalname}: ${res.status} ${err}`);
  }

  let media = await res.json();

  // Video/gif processing can be async: 202 (or a 200 with no url yet) means Mastodon
  // is still transcoding. Poll until it's ready or give up after ~30s.
  const attachmentId = media.id;
  let attempts = 0;
  while (!media.url && attempts < 15) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetchWithContext(`${MASTODON_INSTANCE_URL}/api/v1/media/${attachmentId}`, {
      headers: { Authorization: `Bearer ${MASTODON_ACCESS_TOKEN}` }
    });
    if (pollRes.status === 200) {
      media = await pollRes.json();
      break;
    }
    // 206 = still processing
    attempts++;
  }

  return attachmentId;
}

// Posts `parts` (one or more strings) as a single connected Mastodon
// thread: each status after the first sets in_reply_to_id to the previous
// one. Media (if any) is attached only to the first status.
async function postToMastodon(parts, media, altTexts) {
  if (!MASTODON_ACCESS_TOKEN) {
    throw new Error('Mastodon access token not configured (MASTODON_ACCESS_TOKEN).');
  }

  const files = media.video ? [media.video] : media.images;
  const mediaIds = [];
  for (let i = 0; i < files.length; i++) {
    const id = await mastodonUploadMedia(files[i], altTexts && altTexts[i]);
    mediaIds.push(id);
  }

  let inReplyTo = null;
  const posts = [];

  for (let i = 0; i < parts.length; i++) {
    const body = { status: parts[i], visibility: 'public' };
    if (i === 0 && mediaIds.length) body.media_ids = mediaIds;
    if (inReplyTo) body.in_reply_to_id = inReplyTo;

    const res = await fetchWithContext(`${MASTODON_INSTANCE_URL}/api/v1/statuses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MASTODON_ACCESS_TOKEN}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Mastodon post ${i + 1}/${parts.length} failed: ${res.status} ${err}`);
    }

    const data = await res.json();
    inReplyTo = data.id;
    posts.push({ url: data.url, id: data.id });
  }

  return { url: posts[0].url, id: posts[0].id, thread: posts };
}

// ---- Uploads ----
// This cap is just a sane upper bound to protect server memory (files are
// buffered in RAM) — it's intentionally much larger than any platform's
// actual limit, since the background editor (mediaOptimizer.js) shrinks
// oversized files down to each platform's real limit before posting.
const RAW_UPLOAD_MAX_BYTES = 500_000_000; // 500 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: RAW_UPLOAD_MAX_BYTES,
    files: BLUESKY_LIMITS.maxImages,
  }
});

// ---- API routes ----
app.post('/api/post', upload.array('media', BLUESKY_LIMITS.maxImages), async (req, res) => {
  let targets = [];
  let altTexts = [];
  let parts = [];

  try {
    targets = JSON.parse(req.body?.targets || '[]');
    altTexts = JSON.parse(req.body?.altTexts || '[]');
    // `parts` is the (possibly thread-split) list of post bodies, already
    // divided client-side into pieces that fit the selected platforms'
    // combined text limit, and already carrying their "i/total" counters.
    // A normal, non-split post is just a one-element array.
    if (req.body?.parts) {
      parts = JSON.parse(req.body.parts);
    } else if (req.body?.text) {
      // Back-compat fallback for any older client still sending `text`.
      parts = [String(req.body.text).trim()];
    }
  } catch (e) {
    return res.status(400).json({ error: 'Malformed request.' });
  }

  if (!Array.isArray(parts) || parts.length === 0 || parts.some((p) => typeof p !== 'string' || !p.trim())) {
    return res.status(400).json({ error: 'Post text is required.' });
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'Select at least one platform.' });
  }

  let media;
  try {
    media = await validateMedia(req.files, targets);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const results = {};

  await Promise.all(targets.map(async (target) => {
    try {
      // Each platform gets its own edited copy of the media, built against
      // that platform's own (not the intersected/combined) limits.
      const targetLimits = await getLimitsForTargets([target]);
      const optimizedMedia = await optimizeMediaForTarget(media, targetLimits);

      if (target === 'bluesky') {
        results.bluesky = { ok: true, ...(await postToBluesky(parts, optimizedMedia, altTexts)) };
      } else if (target === 'mastodon') {
        results.mastodon = { ok: true, ...(await postToMastodon(parts, optimizedMedia, altTexts)) };
      }
    } catch (e) {
      results[target] = { ok: false, error: e.message };
    }
  }));

  res.json({ results });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  next(err);
});

app.get('/api/config', async (req, res) => {
  // Lets the UI know which platforms are actually configured, plus each
  // platform's own media limits — the UI combines these based on whichever
  // checkboxes are currently checked, rather than always assuming both.
  const blueskyConfigured = Boolean(BLUESKY_HANDLE && BLUESKY_APP_PASSWORD);
  const mastodonConfigured = Boolean(MASTODON_ACCESS_TOKEN);
  const mastodonLimits = mastodonConfigured ? await getMastodonLimits() : MASTODON_DEFAULT_LIMITS;

  res.json({
    bluesky: blueskyConfigured,
    mastodon: mastodonConfigured,
    mastodonInstance: MASTODON_INSTANCE_URL,
    mediaLimits: {
      bluesky: BLUESKY_LIMITS,
      mastodon: mastodonLimits,
    },
  });
});

app.listen(PORT, () => {
  console.log(`Cross-post admin panel running at http://localhost:${PORT}`);
});
