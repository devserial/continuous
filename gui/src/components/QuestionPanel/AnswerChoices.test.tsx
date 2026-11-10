import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnswerChoices } from "./AnswerChoices";

const setup = (onChoose = vi.fn()) => {
  render(
    <AnswerChoices
      options={["ABNF", "PEG", "Both"]}
      pick="PEG"
      testIdPrefix="q"
      onChoose={onChoose}
    />,
  );
  return { onChoose };
};
const options = () => screen.getAllByTestId("q-option");
const apply = () => screen.getByTestId("q-apply") as HTMLButtonElement;

describe("AnswerChoices", () => {
  it("selecting a choice sends nothing; Answer sends the selection", async () => {
    const { onChoose } = setup();
    expect(apply().disabled).toBe(true);
    fireEvent.click(options()[0]);
    expect(options()[0].getAttribute("aria-checked")).toBe("true");
    expect(onChoose).not.toHaveBeenCalled();
    expect(apply().disabled).toBe(false);
    await act(async () => fireEvent.click(apply()));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("ABNF");
  });

  it("changes the selection, and clicking the selected choice clears it", () => {
    setup();
    fireEvent.click(options()[0]);
    fireEvent.click(options()[1]);
    expect(options()[0].getAttribute("aria-checked")).toBe("false");
    expect(options()[1].getAttribute("aria-checked")).toBe("true");
    fireEvent.click(options()[1]);
    expect(options()[1].getAttribute("aria-checked")).toBe("false");
    expect(apply().disabled).toBe(true);
  });

  it("marks the recommendation without selecting it", () => {
    setup();
    expect(options()[1].textContent).toContain("(recommended)");
    expect(options()[1].getAttribute("aria-checked")).toBe("false");
  });

  it("Other opens a field; Answer stays off until it has text; Enter applies", async () => {
    const { onChoose } = setup();
    fireEvent.click(screen.getByTestId("q-other"));
    const input = screen.getByTestId("q-other-input") as HTMLInputElement;
    expect(apply().disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  a hand parser  " } });
    expect(apply().disabled).toBe(false);
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("a hand parser");
  });

  it("choosing a listed answer after Other drops the field", () => {
    setup();
    fireEvent.click(screen.getByTestId("q-other"));
    expect(screen.queryByTestId("q-other-input")).not.toBeNull();
    fireEvent.click(options()[2]);
    expect(screen.queryByTestId("q-other-input")).toBeNull();
    expect(options()[2].getAttribute("aria-checked")).toBe("true");
  });

  it("waits while the answer is recorded and blocks a second send", async () => {
    let finish!: () => void;
    const onChoose = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    setup(onChoose);
    fireEvent.click(options()[0]);
    await act(async () => fireEvent.click(apply()));
    expect(apply().textContent).toBe("Answering…");
    expect(apply().disabled).toBe(true);
    expect(options()[0].hasAttribute("disabled")).toBe(true);
    await act(async () => fireEvent.click(apply()));
    expect(onChoose).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(apply().textContent).toBe("Answer");
  });
});
