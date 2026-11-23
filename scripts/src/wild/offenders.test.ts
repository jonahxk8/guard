import assert from "node:assert/strict";
import test from "node:test";
import {
  REPEAT_OFFENDER_THRESHOLD,
  clearOffenses,
  getOffenseCount,
  recordOffense,
} from "./offenders.js";

test("recordOffense counts up per server and actor", () => {
  clearOffenses();
  assert.equal(recordOffense("111111111111111111", "222222222222222222"), 1);
  assert.equal(recordOffense("111111111111111111", "222222222222222222"), 2);
  assert.equal(recordOffense("111111111111111111", "222222222222222222"), 3);
  assert.equal(getOffenseCount("111111111111111111", "222222222222222222"), 3);
});

test("counts are independent per server and per actor", () => {
  clearOffenses();
  recordOffense("111111111111111111", "222222222222222222");
  assert.equal(getOffenseCount("111111111111111111", "333333333333333333"), 0);
  assert.equal(getOffenseCount("444444444444444444", "222222222222222222"), 0);
});

test("repeat-offender threshold is 3", () => {
  assert.equal(REPEAT_OFFENDER_THRESHOLD, 3);
});

test("clearOffenses resets all counts", () => {
  recordOffense("111111111111111111", "222222222222222222");
  clearOffenses();
  assert.equal(getOffenseCount("111111111111111111", "222222222222222222"), 0);
});
