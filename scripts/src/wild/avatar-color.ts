import { inflateSync } from "node:zlib";
import type { ImageURLOptions } from "discord.js";

/**
 * Dominant color of a member's profile picture (avatar).
 *
 * Bleed-style: an FG role takes the color of its owner's avatar. No
 * image library is used — the avatar is fetched as a small static PNG
 * and decoded by hand with Node's built-in zlib (Discord serves
 * non-interlaced PNGs). Only 8-bit and 16-bit PNGs are supported and
 * only the color types Discord serves (grayscale, RGB, palette,
 * grayscale+alpha, RGBA); anything else returns null and the caller
 * falls back to a default color instead of failing.
 */

export const DEFAULT_AVATAR_COLOR = "#5865f2";

/** Bucket size per channel when counting colors (8 levels each). */
const BUCKET_SHIFT = 5;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Dominant color of a PNG image: the most common color among opaque
 * pixels (colors are bucketed 32 levels per channel, the most frequent
 * bucket wins, and the pixels in it are averaged). Fully transparent
 * pixels are ignored. Returns a lowercase "#rrggbb", or null when the
 * bytes are not a decodable PNG or have no usable pixels.
 */
export function decodePngDominantColor(buffer: Buffer): string | null {
  if (
    buffer.length < 8 ||
    !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    return null;
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat: Buffer[] = [];
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (offset + 12 + length > buffer.length) return null;
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      plte = Buffer.from(data);
    } else if (type === "tRNS") {
      trns = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height || interlace !== 0) return null;
  if (bitDepth !== 8 && bitDepth !== 16) return null;
  // Channels per pixel: 0 grayscale, 2 RGB, 3 palette, 4 gray+alpha,
  // 6 RGBA. Anything else is not a PNG Discord serves.
  const channels =
    colorType === 0
      ? 1
      : colorType === 2
        ? 3
        : colorType === 3
          ? 1
          : colorType === 4
            ? 2
            : colorType === 6
              ? 4
              : 0;
  if (channels === 0) return null;
  if (colorType === 3 && !plte) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const bytesPerSample = bitDepth / 8;
  const bytesPerPixel = Math.max(1, channels * bytesPerSample);
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  if (raw.length < height * (stride + 1)) return null;

  // Reverse the scanline filters.
  const pixels = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? out[x - bytesPerPixel] : 0;
      const b = prev[x];
      const c = x >= bytesPerPixel ? prev[x - bytesPerPixel] : 0;
      const v = row[x];
      switch (filter) {
        case 0:
          out[x] = v;
          break;
        case 1:
          out[x] = (v + a) & 0xff;
          break;
        case 2:
          out[x] = (v + b) & 0xff;
          break;
        case 3:
          out[x] = (v + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          out[x] = (v + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          return null;
      }
    }
    prev = Buffer.from(out);
  }

  // Most common color among opaque pixels, bucketed 32 levels per
  // channel, then averaged within the winning bucket.
  const buckets = new Map<
    string,
    { count: number; r: number; g: number; b: number }
  >();
  const sample = (index: number): number =>
    bitDepth === 16 ? pixels[index * 2] : pixels[index];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * channels;
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 255;
      if (colorType === 0) {
        r = g = b = sample(base);
      } else if (colorType === 2) {
        r = sample(base);
        g = sample(base + 1);
        b = sample(base + 2);
      } else if (colorType === 3) {
        const paletteIndex = sample(base);
        const entry = paletteIndex * 3;
        if (entry + 2 >= (plte?.length ?? 0)) continue;
        r = plte![entry];
        g = plte![entry + 1];
        b = plte![entry + 2];
        if (trns && paletteIndex < trns.length) alpha = trns[paletteIndex];
      } else if (colorType === 4) {
        r = g = b = sample(base);
        alpha = sample(base + 1);
      } else {
        r = sample(base);
        g = sample(base + 1);
        b = sample(base + 2);
        alpha = sample(base + 3);
      }
      if (alpha < 128) continue;
      const key = `${r >> BUCKET_SHIFT},${g >> BUCKET_SHIFT},${b >> BUCKET_SHIFT}`;
      const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
    }
  }
  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  if (!best || best.count === 0) return null;
  const toHex = (value: number): string =>
    Math.round(value / best!.count)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(best.r)}${toHex(best.g)}${toHex(best.b)}`;
}

export interface AvatarMember {
  displayAvatarURL: (options?: ImageURLOptions) => string;
}

/**
 * Dominant color of a member's profile picture, as a lowercase
 * "#rrggbb". Fetches the avatar as a small static PNG (128px, so the
 * decode is cheap). Returns null when the avatar can't be fetched or
 * decoded — the caller falls back to DEFAULT_AVATAR_COLOR instead of
 * failing the whole command.
 */
export async function getMemberAvatarDominantColor(
  member: AvatarMember,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  let url: string;
  try {
    url = member.displayAvatarURL({
      extension: "png",
      size: 128,
      forceStatic: true,
    });
  } catch {
    return null;
  }
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    return decodePngDominantColor(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
}
