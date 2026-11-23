import assert from "node:assert/strict";
import test from "node:test";
import { FG_HEX_COLOR_COUNT } from "./colors.js";
import {
  HOLOGRAPHIC_COLORS,
  parseFgColor,
  parseFgColorSpec,
  parseFgColorTokens,
  randomFgColor,
  splitColorTokens,
} from "./fg-booster.js";

/**
 * FG colors are hex codes only — no color names. There is no color
 * list anywhere in the bot: no /fg colors command, no help list, no
 * docs list. The bot accepts hex codes (plus the `random`,
 * `holographic`/`holo`, and `dominant` keywords) and nothing else.
 */

test("parseFgColor accepts every hex form", () => {
  assert.equal(parseFgColor("#ff0000"), "#ff0000");
  assert.equal(parseFgColor("ff0000"), "#ff0000");
  assert.equal(parseFgColor("#FF0000"), "#ff0000");
  assert.equal(parseFgColor("#f00"), "#ff0000");
  assert.equal(parseFgColor("f00"), "#ff0000");
  assert.equal(parseFgColor("0x00ff00"), "#00ff00");
  assert.equal(parseFgColor("0X00FF00"), "#00ff00");
  assert.equal(parseFgColor("#00ff00"), "#00ff00");
  assert.equal(parseFgColor("  #0000ff  "), "#0000ff");
  assert.equal(parseFgColor("#000000"), "#000000");
  assert.equal(parseFgColor("#ffffff"), "#ffffff");
});

test("parseFgColor rejects color names — hex codes only", () => {
  // Every name is invalid now, including ones that used to work.
  for (const name of [
    "blue",
    "red",
    "crimson",
    "light blue",
    "LightBlue",
    "dark slate gray",
    "grey",
    "gray",
    "orange",
    "green",
    "pink",
    "turquoise",
    "notacolor",
    "blurple",
  ]) {
    assert.equal(parseFgColor(name), null, `${name} must not parse`);
  }
});

test("parseFgColor rejects invalid hex codes", () => {
  assert.equal(parseFgColor(""), null);
  assert.equal(parseFgColor("#gggggg"), null);
  assert.equal(parseFgColor("#12345"), null);
  assert.equal(parseFgColor("#1234567"), null);
  assert.equal(parseFgColor("12345"), null);
  assert.equal(parseFgColor("0x12345"), null);
  assert.equal(parseFgColor("0x1234567"), null);
  assert.equal(parseFgColor("#12g456"), null);
  assert.equal(parseFgColor("rgb(255,0,0)"), null);
});

test("splitColorTokens splits on spaces and commas", () => {
  assert.deepEqual(splitColorTokens("#ff0000 #0000ff"), ["#ff0000", "#0000ff"]);
  assert.deepEqual(splitColorTokens("#ff0000,#0000ff"), ["#ff0000", "#0000ff"]);
  assert.deepEqual(splitColorTokens("#ff0000, #0000ff"), ["#ff0000", "#0000ff"]);
  assert.deepEqual(splitColorTokens("  #ff0000,,  #0000ff  "), ["#ff0000", "#0000ff"]);
  assert.deepEqual(splitColorTokens(""), []);
});

test("parseFgColorTokens parses one hex, two hexes, and the keywords", () => {
  assert.deepEqual(parseFgColorTokens(["#ff0000"]), {
    choice: { kind: "solid", primary: "#ff0000", secondary: null },
    consumed: 1,
    colorText: "#ff0000",
  });
  assert.deepEqual(parseFgColorTokens(["#ff0000", "#0000ff"]), {
    choice: { kind: "gradient", primary: "#ff0000", secondary: "#0000ff" },
    consumed: 2,
    colorText: "#ff0000 #0000ff",
  });
  assert.deepEqual(parseFgColorTokens(["#ff0000", "#0000ff", "extra"]), {
    choice: { kind: "gradient", primary: "#ff0000", secondary: "#0000ff" },
    consumed: 2,
    colorText: "#ff0000 #0000ff",
  });
  assert.deepEqual(parseFgColorTokens(["dominant"]), {
    choice: { kind: "dominant", primary: "", secondary: null },
    consumed: 1,
    colorText: "dominant",
  });
});

test("parseFgColorTokens rejects extra colors and invalid input", () => {
  // Three colors: Greed-style, the third is an error, never ignored.
  assert.deepEqual(parseFgColorTokens(["#ff0000", "#0000ff", "#00ff00"]), {
    error: "too-many",
  });
  assert.deepEqual(parseFgColorTokens(["blue"]), { error: "invalid" });
  assert.deepEqual(parseFgColorTokens(["notacolor"]), { error: "invalid" });
  assert.deepEqual(parseFgColorTokens([]), { error: "invalid" });
  assert.deepEqual(parseFgColorTokens(["#ff0000", "holographic"]), {
    error: "too-many",
  });
  assert.deepEqual(parseFgColorTokens(["dominant", "#ff0000"]), {
    error: "too-many",
  });
  assert.deepEqual(parseFgColorTokens(["#ff0000", "dominant"]), {
    error: "too-many",
  });
});

test("parseFgColorTokens handles random, holographic, and dominant", () => {
  const random = parseFgColorTokens(["random"]);
  assert.ok(!("error" in random));
  if (!("error" in random)) {
    assert.equal(random.choice.kind, "solid");
    assert.match(random.choice.primary, /^#[0-9a-f]{6}$/);
    assert.equal(random.consumed, 1);
  }
  const randomGradient = parseFgColorTokens(["random", "#0000ff"]);
  assert.ok(!("error" in randomGradient));
  if (!("error" in randomGradient)) {
    assert.equal(randomGradient.choice.kind, "gradient");
    assert.match(randomGradient.choice.primary, /^#[0-9a-f]{6}$/);
    assert.equal(randomGradient.choice.secondary, "#0000ff");
  }
  assert.deepEqual(parseFgColorTokens(["holographic"]), {
    choice: {
      kind: "holographic",
      primary: "#a9c9ff",
      secondary: "#ffbbec",
    },
    consumed: 1,
    colorText: "holographic",
  });
  assert.deepEqual(parseFgColorTokens(["holo"]), {
    choice: {
      kind: "holographic",
      primary: "#a9c9ff",
      secondary: "#ffbbec",
    },
    consumed: 1,
    colorText: "holo",
  });
});

test("holographic colors are Discord's fixed preset", () => {
  assert.deepEqual(HOLOGRAPHIC_COLORS, {
    primary: "#a9c9ff",
    secondary: "#ffbbec",
    tertiary: "#ffc3a0",
  });
});

test("randomFgColor always makes a valid hex color", () => {
  for (let i = 0; i < 100; i++) {
    assert.match(randomFgColor(), /^#[0-9a-f]{6}$/);
  }
});

test("parseFgColorSpec needs the whole string to be colors", () => {
  assert.deepEqual(parseFgColorSpec("#ff0000 #0000ff"), {
    kind: "gradient",
    primary: "#ff0000",
    secondary: "#0000ff",
  });
  assert.deepEqual(parseFgColorSpec("#ff0000,#0000ff"), {
    kind: "gradient",
    primary: "#ff0000",
    secondary: "#0000ff",
  });
  assert.deepEqual(parseFgColorSpec("#ff0000"), {
    kind: "solid",
    primary: "#ff0000",
    secondary: null,
  });
  assert.deepEqual(parseFgColorSpec("holographic"), {
    kind: "holographic",
    primary: "#a9c9ff",
    secondary: "#ffbbec",
  });
  assert.deepEqual(parseFgColorSpec("dominant"), {
    kind: "dominant",
    primary: "",
    secondary: null,
  });
  assert.equal(parseFgColorSpec("#ff0000 #0000ff #00ff00"), null);
  assert.equal(parseFgColorSpec("blue"), null);
  assert.equal(parseFgColorSpec("notacolor"), null);
  assert.equal(parseFgColorSpec(""), null);
});

test("10,000 distinct hex colors all parse", () => {
  // Any hex code works: 16,777,216 possible colors, hex codes only.
  assert.equal(FG_HEX_COLOR_COUNT, 16777216);
  const seen = new Set<string>();
  for (let i = 0; i < 10000; i++) {
    const hex = `#${i.toString(16).padStart(6, "0")}`;
    const parsed = parseFgColor(hex);
    assert.equal(parsed, hex, `${hex} must parse`);
    seen.add(parsed!);
  }
  assert.equal(seen.size, 10000);
});
