import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  DEFAULT_AVATAR_COLOR,
  decodePngDominantColor,
  getMemberAvatarDominantColor,
} from "./avatar-color.js";

/**
 * Avatar dominant color: hand-rolled PNG decode, no image library.
 * Test PNGs are built here with zlib (deflate) and a small CRC32.
 */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * Build a minimal non-interlaced PNG. `pixels` is rows of [r, g, b]
 * or [r, g, b, a] tuples; `colorType` 2 (RGB) or 6 (RGBA). Scanlines
 * use filter 0 (none), so the decoder's filter handling is covered by
 * the Paeth test below instead.
 */
function buildPng(
  width: number,
  height: number,
  pixels: Array<Array<[number, number, number] | [number, number, number, number]>>,
  colorType = 2,
): Buffer {
  const channels = colorType === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace: none
  const raw = Buffer.alloc(height * (1 + width * channels));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * channels);
    raw[rowStart] = 0; // filter 0
    for (let x = 0; x < width; x++) {
      const pixel = pixels[y][x];
      for (let c = 0; c < channels; c++) {
        raw[rowStart + 1 + x * channels + c] = pixel[c] ?? 255;
      }
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("decodePngDominantColor finds the most common color", () => {
  // 3 red pixels, 1 blue pixel: red wins.
  const png = buildPng(2, 2, [
    [
      [255, 0, 0],
      [255, 0, 0],
    ],
    [
      [255, 0, 0],
      [0, 0, 255],
    ],
  ]);
  assert.equal(decodePngDominantColor(png), "#ff0000");
});

test("decodePngDominantColor averages near-identical colors in one bucket", () => {
  // Two almost-red pixels in the same 32-level bucket: averaged.
  const png = buildPng(2, 1, [
    [
      [255, 0, 0],
      [240, 16, 0],
    ],
  ]);
  assert.equal(decodePngDominantColor(png), "#f80800");
});

test("decodePngDominantColor ignores transparent pixels", () => {
  // RGBA: 3 transparent green pixels, 1 opaque blue pixel: blue wins.
  const png = buildPng(
    2,
    2,
    [
      [
        [0, 255, 0, 0],
        [0, 255, 0, 0],
      ],
      [
        [0, 255, 0, 0],
        [0, 0, 255, 255],
      ],
    ],
    6,
  );
  assert.equal(decodePngDominantColor(png), "#0000ff");
});

test("decodePngDominantColor rejects non-PNG bytes and empty images", () => {
  assert.equal(decodePngDominantColor(Buffer.from("not a png")), null);
  assert.equal(decodePngDominantColor(Buffer.alloc(0)), null);
  // A 1x1 fully transparent pixel has no usable color.
  const png = buildPng(1, 1, [[[0, 0, 0, 0]]], 6);
  assert.equal(decodePngDominantColor(png), null);
});

test("getMemberAvatarDominantColor fetches the avatar and reads its color", async () => {
  const png = buildPng(1, 1, [[[0, 128, 255]]]);
  let fetchedUrl = "";
  const fakeFetch = (async (url: string) => {
    fetchedUrl = url;
    return {
      ok: true,
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    };
  }) as unknown as typeof fetch;
  const member = {
    displayAvatarURL: (options?: { extension?: string; size?: number }) => {
      assert.equal(options?.extension, "png");
      assert.equal(options?.size, 128);
      return "https://cdn.discordapp.com/avatars/222/avatar.png";
    },
  };
  assert.equal(
    await getMemberAvatarDominantColor(member, fakeFetch),
    "#0080ff",
  );
  assert.equal(fetchedUrl, "https://cdn.discordapp.com/avatars/222/avatar.png");
});

test("getMemberAvatarDominantColor returns null when the avatar can't be read", async () => {
  const failingFetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const member = {
    displayAvatarURL: () => "https://cdn.discordapp.com/avatars/222/avatar.png",
  };
  assert.equal(
    await getMemberAvatarDominantColor(member, failingFetch),
    null,
  );
  const badFetch = (async () => ({
    ok: false,
    arrayBuffer: async () => new ArrayBuffer(0),
  })) as unknown as typeof fetch;
  assert.equal(await getMemberAvatarDominantColor(member, badFetch), null);
  assert.equal(DEFAULT_AVATAR_COLOR, "#5865f2");
});
