import fs from "fs";
import os from "os";
import path from "path";

import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  approvalExtras,
  getPolicyLevels,
  resetPolicyLevels,
} from "../permissions/policyLevels.js";

import {
  applyLoopWorkerPolicy,
  loopWorkerPermissionOverrides,
} from "./loopWorker.js";

describe("loop worker permissions", () => {
  afterEach(() => {
    resetPolicyLevels();
  });

  it("does not start in auto mode, and keeps the parent's excludes", () => {
    expect(
      loopWorkerPermissionOverrides({
        mode: "auto",
        exclude: ["Bash"],
        allow: ["Read"],
      }),
    ).toEqual({
      allow: ["Read"],
      ask: undefined,
      exclude: ["Bash"],
      mode: "normal",
    });
    expect(loopWorkerPermissionOverrides({ mode: "plan" }).mode).toBe("plan");
    expect(loopWorkerPermissionOverrides(undefined).mode).toBe("normal");
  });

  it("loads the floor from the settings file and then the parent's levels", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-worker-policy-"));
    const file = path.join(dir, "permissions.yaml");
    fs.writeFileSync(
      file,
      "levels:\n  tools: permissive\nfloor:\n  - runTerminalCommand(git push*)\n",
    );
    applyLoopWorkerPolicy(
      {
        levels: { ...DEFAULT_POLICY_LEVELS, tools: "manual" },
      },
      file,
    );
    expect(getPolicyLevels().tools).toBe("manual");
    expect(approvalExtras().floor).toEqual(["runTerminalCommand(git push*)"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
