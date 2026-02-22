import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { average, clamp } from "../src/math-utils.mjs";

describe("average", () => {
  it("returns 0 for empty array", () => {
    assert.equal(average([]), 0);
  });

  it("returns the number itself for single element", () => {
    assert.equal(average([5]), 5);
  });

  it("calculates average of multiple numbers", () => {
    assert.equal(average([2, 4, 6]), 4);
  });

  it("handles negative numbers", () => {
    assert.equal(average([-10, 10]), 0);
  });
});

describe("clamp", () => {
  it("returns value when within range", () => {
    assert.equal(clamp(5, 0, 10), 5);
  });

  it("clamps to min", () => {
    assert.equal(clamp(-5, 0, 10), 0);
  });

  it("clamps to max", () => {
    assert.equal(clamp(15, 0, 10), 10);
  });
});
