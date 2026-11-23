import assert from "node:assert/strict";
import test from "node:test";
import {
  FG_COLOR_COUNT,
  FG_COLOR_LIST,
  FG_COLOR_NAMES,
  FG_HEX_COLOR_COUNT,
} from "./colors.js";
import {
  HOLOGRAPHIC_COLORS,
  parseFgColor,
  parseFgColorSpec,
  parseFgColorTokens,
  parseFgColorTokensFromEnd,
  randomFgColor,
  splitColorTokens,
} from "./fg-booster.js";

/**
 * FG colors: the full CSS named-color list (148 names), plus hex codes.
 * There is no color list anywhere in the bot — no /fg colors command,
 * no help list, no docs list. The bot accepts these names but never
 * shows them.
 */

test("the color table has all 148 CSS named colors", () => {
  assert.equal(FG_COLOR_COUNT, 148);
  assert.equal(FG_COLOR_LIST.length, 148);
  assert.equal(Object.keys(FG_COLOR_NAMES).length, 148);
  // Alphabetical, no duplicates.
  const names = FG_COLOR_LIST.map((entry) => entry.name);
  assert.deepEqual(names, [...names].sort());
  assert.equal(new Set(names).size, 148);
  // Every entry's hex is a lowercase 6-digit hex code.
  for (const entry of FG_COLOR_LIST) {
    assert.match(entry.hex, /^#[0-9A-F]{6}$/, entry.name);
  }
});

test("parseFgColor accepts colors across the list", () => {
  assert.equal(parseFgColor("crimson"), "#dc143c");
  assert.equal(parseFgColor("turquoise"), "#40e0d0");
  assert.equal(parseFgColor("teal"), "#008080");
  assert.equal(parseFgColor("navy"), "#000080");
  assert.equal(parseFgColor("maroon"), "#800000");
  assert.equal(parseFgColor("olive"), "#808000");
  assert.equal(parseFgColor("lime"), "#00ff00");
  assert.equal(parseFgColor("aqua"), "#00ffff");
  assert.equal(parseFgColor("fuchsia"), "#ff00ff");
  assert.equal(parseFgColor("indigo"), "#4b0082");
  assert.equal(parseFgColor("violet"), "#ee82ee");
  assert.equal(parseFgColor("lavender"), "#e6e6fa");
  assert.equal(parseFgColor("beige"), "#f5f5dc");
  assert.equal(parseFgColor("khaki"), "#f0e68c");
  assert.equal(parseFgColor("salmon"), "#fa8072");
  assert.equal(parseFgColor("gold"), "#ffd700");
  assert.equal(parseFgColor("silver"), "#c0c0c0");
  assert.equal(parseFgColor("chocolate"), "#d2691e");
  assert.equal(parseFgColor("rebeccapurple"), "#663399");
});

test("parseFgColor is case-insensitive and spaces are optional", () => {
  assert.equal(parseFgColor("LightBlue"), "#add8e6");
  assert.equal(parseFgColor("light blue"), "#add8e6");
  assert.equal(parseFgColor("LIGHT BLUE"), "#add8e6");
  assert.equal(parseFgColor("  crimson  "), "#dc143c");
  assert.equal(parseFgColor("dark slate gray"), "#2f4f4f");
});

test("parseFgColor accepts grey and gray spellings", () => {
  assert.equal(parseFgColor("grey"), "#808080");
  assert.equal(parseFgColor("gray"), "#808080");
  assert.equal(parseFgColor("darkgrey"), "#a9a9a9");
  assert.equal(parseFgColor("darkgray"), "#a9a9a9");
  assert.equal(parseFgColor("dimgrey"), "#696969");
  assert.equal(parseFgColor("dimgray"), "#696969");
  assert.equal(parseFgColor("lightgrey"), "#d3d3d3");
  assert.equal(parseFgColor("lightgray"), "#d3d3d3");
  assert.equal(parseFgColor("slategrey"), "#708090");
  assert.equal(parseFgColor("slategray"), "#708090");
  assert.equal(parseFgColor("darkslategrey"), "#2f4f4f");
  assert.equal(parseFgColor("lightslategrey"), "#778899");
});

test("parseFgColor keeps the original 10 names at their original values", () => {
  assert.equal(parseFgColor("red"), "#ff0000");
  assert.equal(parseFgColor("orange"), "#ff8800");
  assert.equal(parseFgColor("yellow"), "#ffff00");
  assert.equal(parseFgColor("green"), "#00ff00");
  assert.equal(parseFgColor("blue"), "#0000ff");
  assert.equal(parseFgColor("purple"), "#800080");
  assert.equal(parseFgColor("pink"), "#ff69b4");
  assert.equal(parseFgColor("white"), "#ffffff");
  assert.equal(parseFgColor("black"), "#000000");
  assert.equal(parseFgColor("grey"), "#808080");
});

test("parseFgColor accepts every hex form", () => {
  assert.equal(parseFgColor("#DC143C"), "#dc143c");
  assert.equal(parseFgColor("DC143C"), "#dc143c");
  assert.equal(parseFgColor("#f00"), "#ff0000");
  assert.equal(parseFgColor("f00"), "#ff0000");
  assert.equal(parseFgColor("0x00ff00"), "#00ff00");
  assert.equal(parseFgColor("0X00FF00"), "#00ff00");
  assert.equal(parseFgColor("#00ff00"), "#00ff00");
});

test("parseFgColor rejects invalid names and hex codes", () => {
  assert.equal(parseFgColor("notacolor"), null);
  assert.equal(parseFgColor("blurple"), null);
  assert.equal(parseFgColor(""), null);
  assert.equal(parseFgColor("#gggggg"), null);
  assert.equal(parseFgColor("#12345"), null);
  assert.equal(parseFgColor("#1234567"), null);
  assert.equal(parseFgColor("12345"), null);
  assert.equal(parseFgColor("0x12345"), null);
  assert.equal(parseFgColor("0x1234567"), null);
  assert.equal(parseFgColor("#12g456"), null);
});

test("splitColorTokens splits on spaces and commas", () => {
  assert.deepEqual(splitColorTokens("red blue"), ["red", "blue"]);
  assert.deepEqual(splitColorTokens("red,blue"), ["red", "blue"]);
  assert.deepEqual(splitColorTokens("red, blue"), ["red", "blue"]);
  assert.deepEqual(splitColorTokens("#ff0000,#0000ff"), ["#ff0000", "#0000ff"]);
  assert.deepEqual(splitColorTokens("  red,,  blue  "), ["red", "blue"]);
  assert.deepEqual(splitColorTokens(""), []);
});

test("parseFgColorTokens parses one color, two colors, and multi-word names", () => {
  assert.deepEqual(parseFgColorTokens(["red"]), {
    choice: { kind: "solid", primary: "#ff0000", secondary: null },
    consumed: 1,
    colorText: "red",
  });
  assert.deepEqual(parseFgColorTokens(["red", "blue"]), {
    choice: { kind: "gradient", primary: "#ff0000", secondary: "#0000ff" },
    consumed: 2,
    colorText: "red blue",
  });
  assert.deepEqual(parseFgColorTokens(["#ff0000", "#0000ff", "My", "Role"]), {
    choice: { kind: "gradient", primary: "#ff0000", secondary: "#0000ff" },
    consumed: 2,
    colorText: "#ff0000 #0000ff",
  });
  assert.deepEqual(parseFgColorTokens(["light", "blue", "My", "Role"]), {
    choice: { kind: "solid", primary: "#add8e6", secondary: null },
    consumed: 2,
    colorText: "light blue",
  });
  assert.deepEqual(
    parseFgColorTokens(["dark", "slate", "blue", "red", "My", "Role"]),
    {
      choice: { kind: "gradient", primary: "#483d8b", secondary: "#ff0000" },
      consumed: 4,
      colorText: "dark slate blue red",
    },
  );
});

test("parseFgColorTokens rejects extra colors and invalid input", () => {
  // Three colors: Greed-style, the third is an error, never ignored.
  assert.deepEqual(parseFgColorTokens(["red", "blue", "green"]), {
    error: "too-many",
  });
  assert.deepEqual(parseFgColorTokens(["red", "blue", "green", "My", "Role"]), {
    error: "too-many",
  });
  assert.deepEqual(parseFgColorTokens(["notacolor"]), { error: "invalid" });
  assert.deepEqual(parseFgColorTokens([]), { error: "invalid" });
  assert.deepEqual(parseFgColorTokens(["red", "holographic"]), {
    error: "too-many",
  });
});

test("parseFgColorTokens handles random and holographic", () => {
  const random = parseFgColorTokens(["random"]);
  assert.ok(!("error" in random));
  if (!("error" in random)) {
    assert.equal(random.choice.kind, "solid");
    assert.match(random.choice.primary, /^#[0-9a-f]{6}$/);
    assert.equal(random.consumed, 1);
  }
  const randomGradient = parseFgColorTokens(["random", "blue"]);
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
  assert.deepEqual(parseFgColorSpec("red blue"), {
    kind: "gradient",
    primary: "#ff0000",
    secondary: "#0000ff",
  });
  assert.deepEqual(parseFgColorSpec("red, blue"), {
    kind: "gradient",
    primary: "#ff0000",
    secondary: "#0000ff",
  });
  assert.deepEqual(parseFgColorSpec("light blue"), {
    kind: "solid",
    primary: "#add8e6",
    secondary: null,
  });
  assert.deepEqual(parseFgColorSpec("holographic"), {
    kind: "holographic",
    primary: "#a9c9ff",
    secondary: "#ffbbec",
  });
  assert.equal(parseFgColorSpec("red blue green"), null);
  assert.equal(parseFgColorSpec("red My Role"), null);
  assert.equal(parseFgColorSpec("notacolor"), null);
  assert.equal(parseFgColorSpec(""), null);
});

test("parseFgColorTokensFromEnd parses trailing colors for ,fg create", () => {
  assert.deepEqual(
    parseFgColorTokensFromEnd(["My", "Role", "red", "blue"]),
    {
      choice: { kind: "gradient", primary: "#ff0000", secondary: "#0000ff" },
      nameTokens: ["My", "Role"],
      colorText: "red blue",
    },
  );
  assert.deepEqual(parseFgColorTokensFromEnd(["My", "Role", "light", "blue"]), {
    choice: { kind: "solid", primary: "#add8e6", secondary: null },
    nameTokens: ["My", "Role"],
    colorText: "light blue",
  });
  assert.deepEqual(parseFgColorTokensFromEnd(["My", "Role", "holographic"]), {
    choice: {
      kind: "holographic",
      primary: "#a9c9ff",
      secondary: "#ffbbec",
    },
    nameTokens: ["My", "Role"],
    colorText: "holographic",
  });
  assert.deepEqual(parseFgColorTokensFromEnd(["My", "Role", "red", "blue", "green"]), {
    error: "too-many",
  });
  assert.deepEqual(parseFgColorTokensFromEnd(["My", "Role"]), {
    error: "invalid",
  });
});

test("10,000 distinct hex colors all parse", () => {
  // Any hex code works: 16,777,216 possible colors, plus the 148 names.
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
