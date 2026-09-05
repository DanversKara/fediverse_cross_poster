// Background media editor.
//
// Bluesky and Mastodon each enforce their own byte-size / format / duration
// limits. Rather than rejecting an upload that's too big, we transparently
// re-encode a per-platform copy of it right before it's sent — shrinking
// images (quality + resolution) and re-encoding/trimming video — so the
// person doesn't have to go edit the file themselves first.
//
// Requires: `sharp` (npm) for images, and the `ffmpeg`/`ffprobe` binaries on
// PATH for video (installed via apk in the Dockerfile).

const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) {
        const hint = err.code === 'ENOENT'
          ? ` (${cmd} not found — make sure it's installed in the container)`
          : '';
        return reject(new Error(`${cmd} failed${hint}: ${err.message}\n${stderr}`.trim()));
      }
      resolve({ stdout, stderr });
    });
  });
}

// ---------------- Images ----------------

// Shrinks/re-encodes an image until it satisfies a platform's byte limit,
// pixel-dimension limit(s), and mime-type allow-list. Fast path: if the file
// already fits all of those and is already an allowed format, it's passed
// through untouched so we never re-compress (and lose quality on) a file
// that didn't need it.
//
// Byte size and dimensions are checked independently — a photo can be well
// under the byte cap (e.g. a well-compressed 8192x6144 JPEG) while still
// exceeding a platform's resolution limits. That mismatch is exactly what
// caused Mastodon's "8192x6144 images are not supported" (its
// image_matrix_limit — total width*height — not its byte-size limit) and
// Bluesky's silent, never-finishing loading spinner on images above its
// ~4000px-per-side ceiling.
async function optimizeImageForLimits(buffer, mimetype, limits) {
  const meta = await sharp(buffer, { failOn: 'none' }).rotate().metadata();
  const originalWidth = meta.width || 2048;
  const originalHeight = meta.height || 2048;
  const originalPixels = originalWidth * originalHeight;
  const originalMaxSide = Math.max(originalWidth, originalHeight);

  const formatAllowed = limits.imageMimeTypes.includes(mimetype);
  const sizeAllowed = buffer.length <= limits.imageMaxBytes;
  const dimensionAllowed = !limits.imageMaxDimension || originalMaxSide <= limits.imageMaxDimension;
  const pixelsAllowed = !limits.imageMaxPixels || originalPixels <= limits.imageMaxPixels;

  if (formatAllowed && sizeAllowed && dimensionAllowed && pixelsAllowed) {
    return { buffer, mimetype, edited: false };
  }

  // JPEG is accepted by both Bluesky and vanilla Mastodon, so recompression
  // always targets JPEG rather than juggling per-format quality knobs.
  const targetBytes = Math.max(1, Math.floor(limits.imageMaxBytes * 0.97));

  // Scale down to satisfy whichever resolution constraint(s) apply,
  // independent of the byte-size loop below.
  let scale = 1;
  if (!dimensionAllowed) {
    scale = Math.min(scale, limits.imageMaxDimension / originalMaxSide);
  }
  if (!pixelsAllowed) {
    scale = Math.min(scale, Math.sqrt(limits.imageMaxPixels / originalPixels));
  }

  let quality = 88;
  let bestBuffer = null;

  for (let attempt = 0; attempt < 16; attempt++) {
    const targetWidth = Math.max(320, Math.round(originalWidth * scale));
    let pipeline = sharp(buffer, { failOn: 'none' }).rotate();
    if (targetWidth < originalWidth) {
      pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: true });
    }
    pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true });

    bestBuffer = await pipeline.toBuffer();
    if (bestBuffer.length <= targetBytes) {
      return { buffer: bestBuffer, mimetype: 'image/jpeg', edited: true };
    }

    if (quality > 40) {
      quality -= 8;
    } else {
      scale *= 0.85;
      quality = 60;
    }
  }

  // Ran out of attempts — hand back the smallest version we produced rather
  // than blocking the post outright; it'll be very close to the limit.
  return { buffer: bestBuffer, mimetype: 'image/jpeg', edited: true };
}

// ---------------- Video ----------------

async function ffprobeDuration(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const seconds = parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? seconds : null;
}

// Re-encodes/trims a video until it satisfies a platform's byte limit,
// duration limit, and mime-type allow-list. Fast path: if it already fits,
// it's passed through untouched.
async function optimizeVideoForLimits(buffer, mimetype, originalname, limits) {
  const formatAllowed = limits.videoMimeTypes.includes(mimetype);
  const withinSize = buffer.length <= limits.videoMaxBytes;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crosspost-'));
  const inExt = path.extname(originalname || '') || '.mp4';
  const inPath = path.join(tmpDir, `in${inExt}`);
  const outPath = path.join(tmpDir, 'out.mp4');

  try {
    await fs.writeFile(inPath, buffer);
    const duration = await ffprobeDuration(inPath);
    const needsTrim = Boolean(limits.videoMaxDurationSec && duration && duration > limits.videoMaxDurationSec);

    if (formatAllowed && withinSize && !needsTrim) {
      return { buffer, mimetype, edited: false };
    }

    const targetDuration = needsTrim ? limits.videoMaxDurationSec : (duration || 30);
    const targetBytes = Math.max(1, Math.floor(limits.videoMaxBytes * 0.93)); // headroom for container overhead
    const audioBitrateK = 128;

    let videoBitrateK = Math.max(150, Math.floor((targetBytes * 8) / targetDuration / 1000) - audioBitrateK);

    let scaleFilter = null;
    if (videoBitrateK < 400) scaleFilter = '854:-2';
    if (videoBitrateK < 200) scaleFilter = '640:-2';

    let lastSize = Infinity;
    for (let attempt = 0; attempt < 3; attempt++) {
      const args = ['-y', '-i', inPath];
      if (needsTrim) args.push('-t', String(targetDuration));
      if (scaleFilter) args.push('-vf', `scale=${scaleFilter}`);
      args.push(
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-b:v', `${videoBitrateK}k`,
        '-maxrate', `${Math.round(videoBitrateK * 1.2)}k`,
        '-bufsize', `${videoBitrateK * 2}k`,
        '-c:a', 'aac',
        '-b:a', `${audioBitrateK}k`,
        '-movflags', '+faststart',
        outPath
      );
      await run('ffmpeg', args);
      const stat = await fs.stat(outPath);
      lastSize = stat.size;

      if (stat.size <= limits.videoMaxBytes || attempt === 2) {
        const outBuffer = await fs.readFile(outPath);
        return { buffer: outBuffer, mimetype: 'video/mp4', edited: true };
      }
      videoBitrateK = Math.max(120, Math.floor(videoBitrateK * 0.75));
    }

    // Unreachable in practice (loop always returns by the final attempt),
    // but keep a safety fallback.
    const outBuffer = await fs.readFile(outPath);
    return { buffer: outBuffer, mimetype: 'video/mp4', edited: true, size: lastSize };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { optimizeImageForLimits, optimizeVideoForLimits };
