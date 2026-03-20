import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS_DIR = join(import.meta.dirname, "..", "scripts");

describe("runner service scripts", () => {
  describe("setup-runner-service.ps1", () => {
    const scriptPath = join(SCRIPTS_DIR, "setup-runner-service.ps1");

    it("exists", () => {
      assert.ok(existsSync(scriptPath), "setup-runner-service.ps1 should exist");
    });

    it("requires admin privileges", () => {
      const content = readFileSync(scriptPath, "utf-8");
      assert.ok(
        content.includes("#Requires -RunAsAdministrator"),
        "script should require admin"
      );
    });

    it("accepts RunnerRoot parameter", () => {
      const content = readFileSync(scriptPath, "utf-8");
      assert.ok(
        content.includes("$RunnerRoot"),
        "script should accept RunnerRoot parameter"
      );
    });

    it("supports uninstall mode", () => {
      const content = readFileSync(scriptPath, "utf-8");
      assert.ok(
        content.includes("[switch]$Uninstall"),
        "script should support -Uninstall switch"
      );
    });

    it("configures auto-start", () => {
      const content = readFileSync(scriptPath, "utf-8");
      assert.ok(
        content.includes("start= auto"),
        "script should set service to auto-start"
      );
    });

    it("configures failure recovery", () => {
      const content = readFileSync(scriptPath, "utf-8");
      assert.ok(
        content.includes("sc.exe failure"),
        "script should configure failure recovery"
      );
    });

    it("uses correct service name convention", () => {
      const content = readFileSync(scriptPath, "utf-8");
      assert.ok(
        content.includes("actions.runner."),
        "service name should follow GitHub Actions convention"
      );
    });
  });

  describe("verify-runner-service.ps1", () => {
    const scriptPath = join(SCRIPTS_DIR, "verify-runner-service.ps1");

    it("exists", () => {
      assert.ok(
        existsSync(scriptPath),
        "verify-runner-service.ps1 should exist"
      );
    });

    it("does not require admin", () => {
      const content = readFileSync(scriptPath, "utf-8");
      assert.ok(
        !content.includes("#Requires -RunAsAdministrator"),
        "verification script should not require admin"
      );
    });

    it("checks service existence", () => {
      const content = readFileSync(scriptPath, "utf-8");
      assert.ok(
        content.includes("Get-Service"),
        "should check service status via Get-Service"
      );
    });

    it("checks auto-start configuration", () => {
      const content = readFileSync(scriptPath, "utf-8");
      assert.ok(
        content.includes("StartType"),
        "should verify service start type"
      );
    });

    it("checks for competing listener processes", () => {
      const content = readFileSync(scriptPath, "utf-8");
      assert.ok(
        content.includes("Runner.Listener"),
        "should check for competing Runner.Listener processes"
      );
    });
  });

  describe("install-runner-service.cmd", () => {
    const scriptPath = join(SCRIPTS_DIR, "install-runner-service.cmd");

    it("exists", () => {
      assert.ok(
        existsSync(scriptPath),
        "install-runner-service.cmd should exist"
      );
    });

    it("self-elevates to admin", () => {
      const content = readFileSync(scriptPath, "utf-8");
      assert.ok(
        content.includes("RunAs"),
        "batch script should request elevation via RunAs"
      );
    });

    it("calls the PowerShell setup script", () => {
      const content = readFileSync(scriptPath, "utf-8");
      assert.ok(
        content.includes("setup-runner-service.ps1"),
        "should invoke the PowerShell setup script"
      );
    });
  });
});
