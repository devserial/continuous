import { act, screen } from "@testing-library/react";
import type { LoopState } from "core";
import { createLoop, startItemRun } from "core/util/loopMode";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setLoop, setLoopRequested } from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { LoopPhaseMark } from "./LoopPhaseMark";

const T0 = new Date("2026-11-09T10:00:00Z");
const base = (): LoopState =>
  createLoop(
    {
      items: [{ id: "1", text: "A", status: "pending" }],
      updatedAt: T0.toISOString(),
    },
    { now: T0, sessionTokens: 0 },
  );

async function setup() {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<LoopPhaseMark label />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  const set = async (loop: LoopState | undefined) =>
    act(async () => {
      store.dispatch(setLoop(loop));
    });
  const phase = () => screen.getByTestId("loop-phase").dataset.phase;
  /** Which lobe of the figure eight is lit: planning, building, or both. */
  const lit = () => screen.getByRole("img").getAttribute("data-lit");
  const lobeOpacity = (half: "planning" | "building") =>
    screen.getByTestId(`loop-phase-${half}`).style.opacity;
  return { store, set, phase, lit, lobeOpacity };
}

describe("LoopPhaseMark", () => {
  it("is at rest with both lobes lit with no loop, and planning once Loop is chosen", async () => {
    const { store, phase, lit } = await setup();
    expect(phase()).toBe("idle");
    expect(lit()).toBe("both");
    await act(async () => {
      store.dispatch(setLoopRequested(true));
    });
    expect(phase()).toBe("planning");
    expect(lit()).toBe("planning");
  });

  it("lights the planning lobe for a planning turn and the building lobe for a building turn", async () => {
    const { set, phase, lit, lobeOpacity } = await setup();
    const running = startItemRun(base(), "1", 0, T0);
    await set(running);
    expect(phase()).toBe("building");
    expect(lit()).toBe("building");
    expect(lobeOpacity("building")).toBe("1");
    expect(lobeOpacity("planning")).toBe("0.35");

    await set({
      ...running,
      current: { kind: "replan", startedAt: T0.toISOString(), historyIndex: 0 },
      status: "replanning",
    } as LoopState);
    expect(phase()).toBe("planning");
    expect(lit()).toBe("planning");
    expect(lobeOpacity("planning")).toBe("1");
    expect(lobeOpacity("building")).toBe("0.35");
    expect(screen.getByTestId("loop-phase").textContent).toContain("Planning");
  });

  it("each lobe holds a dot of the other's colour", async () => {
    await setup();
    const dot = (half: "planning" | "building") =>
      screen.getByTestId(`loop-phase-${half}`).querySelector("circle")!;
    const stroke = (half: "planning" | "building") =>
      screen.getByTestId(`loop-phase-${half}`).querySelector("path")!;
    expect(dot("planning").getAttribute("fill")).toBe(
      stroke("building").getAttribute("stroke"),
    );
    expect(dot("building").getAttribute("fill")).toBe(
      stroke("planning").getAttribute("stroke"),
    );
  });

  it("a plan waiting for the person is still planning", async () => {
    const { set, phase } = await setup();
    await set({ ...base(), status: "awaiting_plan" });
    expect(phase()).toBe("planning");
  });

  it("waiting and stopped keep the lobe it was on, dimmed", async () => {
    const { set, phase, lit } = await setup();
    await set(startItemRun(base(), "1", 0, T0));
    expect(lit()).toBe("building");
    await set({ ...base(), status: "waiting" });
    expect(phase()).toBe("waiting");
    expect(lit()).toBe("building");
    await set({ ...base(), status: "stopped" });
    expect(phase()).toBe("stopped");
    expect(lit()).toBe("building");
    expect(screen.getByRole("img").getAttribute("style")).toContain(
      "opacity: 0.55",
    );
  });
});
