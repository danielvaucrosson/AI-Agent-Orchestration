// tests/pulse-check.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRun,
} from "../scripts/pulse-check.mjs";

describe("classifyRun", () => {
  it("returns healthy for a queued run under 2 minutes", () => {
    const now = new Date("2026-03-15T12:02:00Z");
    const run = {
      status: "queued",
      created_at: "2026-03-15T12:01:00Z",
    };
    assert.equal(classifyRun(run, now), "healthy");
  });

  it("returns stuck-queued for a queued run at exactly 2 minutes", () => {
    const now = new Date("2026-03-15T12:02:00Z");
    const run = {
      status: "queued",
      created_at: "2026-03-15T12:00:00Z",
    };
    assert.equal(classifyRun(run, now), "stuck-queued");
  });

  it("returns stuck-queued for a queued run over 2 minutes", () => {
    const now = new Date("2026-03-15T12:05:00Z");
    const run = {
      status: "queued",
      created_at: "2026-03-15T12:00:00Z",
    };
    assert.equal(classifyRun(run, now), "stuck-queued");
  });

  it("returns healthy for an in_progress run under 60 minutes", () => {
    const now = new Date("2026-03-15T12:30:00Z");
    const run = {
      status: "in_progress",
      run_started_at: "2026-03-15T12:00:00Z",
      created_at: "2026-03-15T11:59:00Z",
    };
    assert.equal(classifyRun(run, now), "healthy");
  });

  it("returns stuck-running for an in_progress run at exactly 60 minutes", () => {
    const now = new Date("2026-03-15T13:00:00Z");
    const run = {
      status: "in_progress",
      run_started_at: "2026-03-15T12:00:00Z",
      created_at: "2026-03-15T11:59:00Z",
    };
    assert.equal(classifyRun(run, now), "stuck-running");
  });

  it("returns stuck-running for an in_progress run over 60 minutes", () => {
    const now = new Date("2026-03-15T14:00:00Z");
    const run = {
      status: "in_progress",
      run_started_at: "2026-03-15T12:00:00Z",
      created_at: "2026-03-15T11:59:00Z",
    };
    assert.equal(classifyRun(run, now), "stuck-running");
  });

  it("falls back to created_at when run_started_at is missing for in_progress", () => {
    const now = new Date("2026-03-15T13:01:00Z");
    const run = {
      status: "in_progress",
      created_at: "2026-03-15T12:00:00Z",
    };
    assert.equal(classifyRun(run, now), "stuck-running");
  });

  it("returns healthy for completed runs", () => {
    const now = new Date("2026-03-15T14:00:00Z");
    const run = {
      status: "completed",
      created_at: "2026-03-15T12:00:00Z",
    };
    assert.equal(classifyRun(run, now), "healthy");
  });

  it("returns healthy for unknown statuses", () => {
    const now = new Date("2026-03-15T14:00:00Z");
    const run = {
      status: "waiting",
      created_at: "2026-03-15T12:00:00Z",
    };
    assert.equal(classifyRun(run, now), "healthy");
  });
});
