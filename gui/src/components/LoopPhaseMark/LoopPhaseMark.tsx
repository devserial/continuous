import { useRef } from "react";
import { useAppSelector } from "../../redux/hooks";
import {
  LOOP_PHASE_LABEL,
  selectLoopPhase,
  type LoopPhase,
} from "../../redux/selectors/selectLoopPhase";
import { LOOP_COLORS } from "../mainInput/GradientBorder";

type Half = "planning" | "building";

const HALF: Partial<Record<LoopPhase, Half>> = {
  planning: "planning",
  building: "building",
};

/**
 * The two halves of the figure eight, each running from the crossing around
 * its own lobe (the same curves as the Continuous logo, brand-src/mark.svg).
 */
const PLANNING_PATH =
  "M256 256 C212 172 100 172 100 256 C100 340 212 340 256 256";
const BUILDING_PATH =
  "M256 256 C300 172 412 172 412 256 C412 340 300 340 256 256";

interface LoopPhaseMarkProps {
  className?: string;
  /** Show the phase beside the mark */
  label?: boolean;
}

/**
 * Loop's mark: the Continuous infinity as a yin and yang. The left lobe is
 * planning (cyan), the right building (indigo), and each carries a bead of the
 * other's colour, diagonally opposite, so the figure turns into itself. The lobe of the turn the loop is in is lit and the other
 * dims; at rest the mark dims as a whole and keeps the lobe it last used lit,
 * so a glance still says what the loop did last.
 */
export function LoopPhaseMark({ className, label }: LoopPhaseMarkProps) {
  const phase = useAppSelector(selectLoopPhase);
  // A rest keeps the half of the turn before it
  const last = useRef<Half | undefined>(undefined);
  if (HALF[phase]) last.current = HALF[phase];
  const resting = HALF[phase] === undefined;
  const lit = last.current;
  const text = LOOP_PHASE_LABEL[phase];

  const lobe = (half: Half) => ({
    opacity: lit === undefined || lit === half ? 1 : 0.35,
    transition: "opacity 500ms ease",
  });

  return (
    <span
      data-testid="loop-phase"
      data-phase={phase}
      title={`Loop: ${text.toLowerCase()}`}
      className="inline-flex items-center gap-1"
    >
      <svg
        viewBox="70 160 372 192"
        role="img"
        aria-label={`Loop: ${text}`}
        data-lit={lit ?? "both"}
        className={className ?? "h-3 w-6"}
        style={{ opacity: resting ? 0.55 : 1 }}
      >
        <g
          data-testid="loop-phase-planning"
          style={lobe("planning")}
          className="motion-reduce:!transition-none"
        >
          <path
            d={PLANNING_PATH}
            fill="none"
            stroke={LOOP_COLORS.cyan}
            strokeWidth="52"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* building's colour, a bead on the planning lobe */}
          <circle cx="161.5" cy="319" r="34" fill={LOOP_COLORS.indigo} />
        </g>
        <g
          data-testid="loop-phase-building"
          style={lobe("building")}
          className="motion-reduce:!transition-none"
        >
          <path
            d={BUILDING_PATH}
            fill="none"
            stroke={LOOP_COLORS.indigo}
            strokeWidth="52"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* planning's colour, a bead on the building lobe */}
          <circle cx="350.5" cy="193" r="34" fill={LOOP_COLORS.cyan} />
        </g>
      </svg>
      {label && <span>{text}</span>}
    </span>
  );
}
