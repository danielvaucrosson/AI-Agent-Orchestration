import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { greet } from "../src/hello.mjs";

describe("greet", () => {
  it("returns default greeting when no name given", () => {
    assert.equal(greet(), "Hello, World!");
  });

  it("returns personalized greeting", () => {
    assert.equal(greet("Alice"), "Hello, Alice!");
  });

  it("handles empty string", () => {
    assert.equal(greet(""), "Hello, !");
  });
});
