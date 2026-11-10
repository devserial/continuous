import { useState } from "react";

interface AnswerChoicesProps {
  options: string[];
  /** The agent's recommendation, marked on its choice */
  pick?: string;
  /** The answer already given, shown as selected */
  selected?: string;
  disabled?: boolean;
  /** Placeholder for the "Other" field */
  otherPlaceholder?: string;
  maxLength?: number;
  testIdPrefix: string;
  /** Sends the answer. May be async: the button waits for it. */
  onChoose: (answer: string) => void | Promise<unknown>;
}

const OTHER = Symbol("other");

/**
 * The choices a question offers, to select and then apply. Selecting is local
 * and instant: it marks a choice and sends nothing, so a stray click answers
 * nothing and the person can change their mind. "Other" opens a field for an
 * answer of one's own, so the person is never limited to the agent's list.
 * **Answer** sends the selection (Enter does the same in the field) and waits
 * while it is recorded.
 */
export function AnswerChoices({
  options,
  pick,
  selected,
  disabled,
  otherPlaceholder = "Your answer",
  maxLength,
  testIdPrefix,
  onChoose,
}: AnswerChoicesProps) {
  const [choice, setChoice] = useState<string | typeof OTHER | undefined>(
    undefined,
  );
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);

  const answer =
    choice === OTHER ? text.trim() : (choice as string | undefined);
  const canApply = !disabled && !pending && !!answer;
  const apply = async () => {
    if (!canApply || !answer) return;
    setPending(true);
    try {
      await onChoose(answer);
    } finally {
      setPending(false);
    }
  };

  const buttonClass =
    "cursor-pointer rounded border border-solid border-border px-1.5 py-0.5 text-xs text-foreground disabled:cursor-default disabled:opacity-50";
  const marked = (option: string) =>
    selected === option || (choice !== OTHER && choice === option);

  return (
    <div className="mt-1">
      <div
        role="radiogroup"
        aria-label="Choices"
        className="flex flex-wrap items-center gap-1"
      >
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={marked(option)}
            data-testid={`${testIdPrefix}-option`}
            disabled={disabled || pending}
            title={
              option === pick
                ? "The agent's recommendation. Select it, then press Answer."
                : "Select this choice, then press Answer"
            }
            className={`${buttonClass} ${
              marked(option)
                ? "bg-button text-button-foreground"
                : "bg-transparent hover:bg-input"
            }`}
            onClick={() => setChoice(marked(option) ? undefined : option)}
          >
            {option}
            {option === pick ? " (recommended)" : ""}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={choice === OTHER}
          data-testid={`${testIdPrefix}-other`}
          disabled={disabled || pending}
          className={`${buttonClass} ${
            choice === OTHER
              ? "bg-button text-button-foreground"
              : "bg-transparent hover:bg-input"
          }`}
          onClick={() => setChoice(choice === OTHER ? undefined : OTHER)}
        >
          Other…
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-apply`}
          disabled={!canApply}
          title={answer ? `Answer: ${answer}` : "Select a choice first"}
          className={`${buttonClass} ml-auto bg-transparent hover:bg-input`}
          onClick={() => void apply()}
        >
          {pending ? "Answering…" : "Answer"}
        </button>
      </div>
      {choice === OTHER && (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
          <input
            data-testid={`${testIdPrefix}-other-input`}
            autoFocus
            value={text}
            maxLength={maxLength}
            placeholder={otherPlaceholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void apply();
              }
            }}
            className="min-w-0 flex-1 basis-40 rounded border border-solid border-border bg-input px-1 text-xs text-foreground placeholder:text-description-muted"
          />
        </div>
      )}
    </div>
  );
}
