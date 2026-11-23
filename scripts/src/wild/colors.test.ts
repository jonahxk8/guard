import assert from "node:assert/strict";
import test from "node:test";
import {
  FG_COLOR_COUNT,
  FG_COLOR_LIST,
  FG_COLOR_NAMES,
} from "./colors.js";
import { parseFgColor } from "./fg-booster.js";

/**
 * FG colours: the full CSS named-colour list (148 names), plus hex codes.
 * The /fg colors list shows exactly these 148 names.
 */

test("the colour table has all 148 CSS named colours", () => {
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

test("parseFgColor accepts colours across the list", () => {
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
  assert.equal(parseFgColor("notacolour"), null);
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
