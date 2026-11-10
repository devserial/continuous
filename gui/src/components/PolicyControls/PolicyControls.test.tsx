import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import { setPolicyLevel } from "../../redux/slices/uiSlice";
import { setupStore } from "../../redux/store";
import { loadPolicySettings } from "../../redux/thunks/policySettings";
import { renderWithProviders } from "../../util/test/render";
import { PolicyCard } from "./PolicyCard";
import { PolicyControls, YoloBanner } from "./PolicyControls";

async function setup(experimental = false) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(
    <>
      <PolicyControls />
      <YoloBanner />
      <PolicyCard />
    </>,
    { store, mockIdeMessenger: ideMessenger },
  );
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        experimental: { enableAutoApproval: experimental },
      } as any),
    );
  });
  return { ...view, store };
}

describe("PolicyControls", () => {
  it("shows one dropdown per area, each at its default, and no warning", async () => {
    const { store } = await setup();
    expect(store.getState().ui.policyLevels).toEqual({
      context: "permissive",
      tools: "cautious",
      edits: "manual",
      plan: "cautious",
      questions: "cautious",
    });
    for (const area of ["context", "tools", "edits", "plan", "questions"]) {
      expect(screen.getAllByTestId(`policy-select-${area}`)).toHaveLength(2);
    }
    expect(screen.getAllByTestId("policy-preset")[0].textContent).toContain(
      "Careful",
    );
    expect(screen.queryByTestId("yolo-banner")).toBeNull();
  });

  it("the toolbar chip is an icon whose colour and name follow the level", async () => {
    const { store } = await setup();
    // Defaults: context permissive (amber), tools cautious (green), edits manual (green)
    const chip = (area: string) =>
      screen.getAllByTestId(`policy-select-${area}`)[0];
    expect(chip("context").className).toContain("text-warning");
    expect(chip("tools").className).toContain("text-success");
    expect(chip("edits").className).toContain("text-success");
    // The level's name is there for screen readers and the tooltip, not as text
    expect(chip("context").getAttribute("aria-label")).toBe(
      "Context use: Permissive",
    );
    expect(screen.getAllByTestId("policy-level-edits")[0].className).toContain(
      "sr-only",
    );
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "tools", level: "yolo" }));
    });
    expect(chip("tools").className).toContain("text-error");
  });

  it("each area has its own five levels, and choosing one changes only that area", async () => {
    const { user, store } = await setup();
    await user.click(screen.getAllByTestId("policy-select-tools")[0]);
    for (const level of ["manual", "cautious", "permissive", "yolo"]) {
      expect(screen.getByTestId(`policy-option-tools-${level}`)).toBeDefined();
    }
    await user.click(screen.getByTestId("policy-option-tools-permissive"));
    expect(store.getState().ui.policyLevels).toMatchObject({
      tools: "permissive",
      context: "permissive",
      edits: "manual",
    });
    expect(screen.getAllByTestId("policy-preset")[0].textContent).toContain(
      "Custom",
    );
  });

  it("Automatic is listed but disabled until a reviewer model is chosen", async () => {
    const { user } = await setup(true);
    await user.click(screen.getAllByTestId("policy-select-tools")[0]);
    const auto = screen.getByTestId("policy-option-tools-automatic");
    expect(auto.textContent).toContain("Not available");
    expect(auto.getAttribute("data-disabled")).not.toBeNull();
  });

  it("Plan edits and Questions call their top level IDGAF; the others call it YOLO", async () => {
    const { user } = await setup();
    await user.click(screen.getAllByTestId("policy-select-questions")[0]);
    expect(
      screen.getByTestId("policy-option-questions-yolo").textContent,
    ).toContain("IDGAF");
  });

  it("an area at YOLO shows a banner that names it and stays", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "questions", level: "yolo" }));
    });
    const banner = screen.getByTestId("yolo-banner");
    expect(banner.textContent).toContain("Questions (IDGAF)");
    expect(banner.textContent).toContain("Deny rules");
    // Unrelated state changes do not remove it.
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "context", level: "manual" }));
    });
    expect(screen.getByTestId("yolo-banner")).toBeDefined();
  });

  it("the banner's button goes back to Careful", async () => {
    const { user, store } = await setup();
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "tools", level: "yolo" }));
    });
    await user.click(screen.getByText("Back to Careful"));
    expect(store.getState().ui.policyLevels.tools).toBe("cautious");
    expect(screen.queryByTestId("yolo-banner")).toBeNull();
  });

  it("a preset sets every area at once", async () => {
    const { user, store } = await setup();
    await user.click(screen.getAllByTestId("policy-preset")[0]);
    await user.click(screen.getByTestId("policy-preset-yolo"));
    expect(Object.values(store.getState().ui.policyLevels)).toEqual(
      Array(5).fill("yolo"),
    );
    expect(screen.getByTestId("yolo-banner")).toBeDefined();
  });

  it("Settings shows the same five rows", async () => {
    await setup();
    for (const area of ["context", "tools", "edits", "plan", "questions"]) {
      expect(screen.getByTestId(`policy-row-${area}`)).toBeDefined();
    }
  });
});

describe("the settings beside the levels", () => {
  it("a built-in rule is on until it is switched off, and the change is saved", async () => {
    const ideMessenger = new MockIdeMessenger();
    const saved: any[] = [];
    ideMessenger.responseHandlers["policy/save"] = (async (data: any) => {
      saved.push(data);
    }) as any;
    const store = setupStore({ ideMessenger });
    const { user } = await renderWithProviders(<PolicyCard />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    expect(store.getState().ui.policyExtras.builtin?.["protect-secrets"]).toBe(
      undefined,
    );
    await user.click(
      screen
        .getByTestId("builtin-protect-secrets")
        .querySelector(".rounded-full")!,
    );
    expect(store.getState().ui.policyExtras.builtin).toEqual({
      "protect-secrets": false,
    });
    expect(saved.at(-1).builtin).toEqual({ "protect-secrets": false });
  });

  it("who decides a question type moves it between the two lists", async () => {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    const { user } = await renderWithProviders(<PolicyCard />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    const row = screen.getByTestId("question-type-design");
    await user.selectOptions(row.querySelector("select")!, "agent");
    expect(store.getState().ui.policyExtras.questions?.agentDecides).toContain(
      "design",
    );
    expect(store.getState().ui.policyExtras.questions?.youDecide).not.toContain(
      "design",
    );
  });

  it("loads the shared file at startup: levels, switches and the floor", async () => {
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responseHandlers["policy/load"] = (async () => ({
      settings: {
        levels: {
          context: "permissive",
          tools: "permissive",
          edits: "manual",
          plan: "cautious",
          questions: "cautious",
        },
        builtin: { "protect-network-paths": false },
        floor: ["runTerminalCommand(terraform destroy*)"],
      },
      notices: [],
    })) as any;
    const store = setupStore({ ideMessenger });
    await renderWithProviders(<PolicyCard />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    await act(async () => {
      await store.dispatch(loadPolicySettings());
    });
    expect(store.getState().ui.policyLevels.tools).toBe("permissive");
    expect(store.getState().ui.policyExtras.floor).toHaveLength(1);
    expect(screen.getByTestId("policy-floor").textContent).toContain(
      "1 floor rule",
    );
  });

  it("a YOLO left from an earlier session is dropped by the load", async () => {
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responseHandlers["policy/load"] = (async () => ({
      settings: {
        levels: {
          context: "permissive",
          tools: "cautious",
          edits: "manual",
          plan: "cautious",
          questions: "cautious",
        },
      },
      notices: [],
    })) as any;
    const store = setupStore({ ideMessenger });
    await act(async () => {
      store.dispatch(setPolicyLevel({ area: "tools", level: "yolo" }));
      await store.dispatch(loadPolicySettings());
    });
    expect(store.getState().ui.policyLevels.tools).toBe("cautious");
  });
});
