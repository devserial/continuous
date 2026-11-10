import {
  BoltIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardDocumentListIcon,
  EyeIcon,
  ExclamationTriangleIcon,
  HandRaisedIcon,
  LockOpenIcon,
  PencilSquareIcon,
  QuestionMarkCircleIcon,
  ShieldCheckIcon,
  SparklesIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import {
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  POLICY_LEVEL_DESCRIPTIONS,
  POLICY_LEVELS,
  POLICY_PRESET_ORDER,
  POLICY_PRESETS,
  policyLevelLabel,
  presetOf,
  type PolicyArea,
  type PolicyLevel,
} from "core/tools/permissions/policy";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  REVIEWABLE_AREAS,
  selectAutoApproval,
  selectEffectiveLevels,
  selectYoloAreas,
} from "../../redux/selectors/selectAutoApproval";
import {
  applyPolicyPreset,
  changePolicyLevel,
} from "../../redux/thunks/policySettings";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "../ui";

const AREA_ICONS: Record<PolicyArea, typeof EyeIcon> = {
  context: EyeIcon,
  tools: WrenchScrewdriverIcon,
  edits: PencilSquareIcon,
  plan: ClipboardDocumentListIcon,
  questions: QuestionMarkCircleIcon,
};

/**
 * A glyph and a colour for each level, so a chip reads without its text: the
 * glyph says what happens (a raised hand asks you, a shield checks against
 * your rules, sparkles is the reviewer model, an open lock lets rules decide,
 * a bolt ignores them) and the colour says how far the trust goes, from green
 * (you decide) through blue (a reviewer) and amber (rules only) to red
 * (nothing checks).
 */
const LEVEL_GLYPHS: Record<PolicyLevel, typeof EyeIcon> = {
  manual: HandRaisedIcon,
  cautious: ShieldCheckIcon,
  automatic: SparklesIcon,
  permissive: LockOpenIcon,
  yolo: BoltIcon,
};

const LEVEL_TONES: Record<PolicyLevel, { chip: string; text: string }> = {
  manual: { chip: "bg-success/20 text-success", text: "text-success" },
  cautious: { chip: "bg-success/20 text-success", text: "text-success" },
  automatic: { chip: "bg-link/20 text-link", text: "text-link" },
  permissive: { chip: "bg-warning/20 text-warning", text: "text-warning" },
  yolo: { chip: "bg-error/20 text-error", text: "text-error" },
};

const AREA_HINTS: Record<PolicyArea, string> = {
  context: "Reading files and searching: what the agent looks at",
  tools: "Commands, MCP tools and the web: what the agent runs",
  edits: "Changing files: what the agent keeps",
  plan: "Loop: what happens to a plan or re-plan",
  questions: "Loop: who answers the agent's questions",
};

/** Why Automatic cannot be chosen for an area, or undefined when it can. */
function automaticUnavailable(
  area: PolicyArea,
  status: ReturnType<typeof selectAutoApproval>,
): string | undefined {
  if (!REVIEWABLE_AREAS.includes(area)) {
    return "A reviewer for this area is not built yet.";
  }
  if (!status.offered) {
    return "Turn on experimental auto approval and choose a reviewer model.";
  }
  if (!status.available) return status.unavailableReason ?? "No reviewer.";
  return undefined;
}

interface AreaLevelSelectProps {
  area: PolicyArea;
  /** icon: the toolbar's compact button. row: a labelled button for Settings. */
  variant: "icon" | "row";
}

/** One area's dropdown. The same control in the toolbar and in Settings. */
export function AreaLevelSelect({ area, variant }: AreaLevelSelectProps) {
  const dispatch = useAppDispatch();
  const saved = useAppSelector((s) => s.ui.policyLevels[area]);
  const effective = useAppSelector((s) => selectEffectiveLevels(s)[area]);
  const status = useAppSelector(selectAutoApproval);
  const Icon = AREA_ICONS[area];
  const label = `${POLICY_AREA_LABELS[area]}: ${policyLevelLabel(area, saved)}`;
  // A saved Automatic that cannot run is in force as Cautious, so say so
  const shown: PolicyLevel = saved === "automatic" ? effective : saved;
  const LevelGlyph = LEVEL_GLYPHS[shown];
  const tone = LEVEL_TONES[shown];

  return (
    <Listbox
      value={shown}
      onChange={(level: PolicyLevel) =>
        void dispatch(changePolicyLevel({ area, level }))
      }
    >
      <div
        className="relative"
        title={`${label}. ${POLICY_LEVEL_DESCRIPTIONS[area][shown]}`}
      >
        <ListboxButton
          data-testid={`policy-select-${area}`}
          aria-label={label}
          className={`flex-none gap-1 rounded-full border-none transition-colors duration-200 hover:brightness-110 ${tone.chip} ${
            variant === "row" ? "px-1.5 py-0.5" : "px-1.5 py-1"
          }`}
        >
          {variant === "row" ? (
            <>
              <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
              <LevelGlyph className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>{policyLevelLabel(area, shown)}</span>
              <ChevronDownIcon
                className="h-2 w-2 shrink-0"
                aria-hidden="true"
              />
            </>
          ) : (
            <>
              <span className="relative flex">
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <LevelGlyph
                  className="absolute -right-1.5 -bottom-1 h-2.5 w-2.5 rounded-full bg-background p-px"
                  aria-hidden="true"
                />
              </span>
              <span className="sr-only" data-testid={`policy-level-${area}`}>
                {policyLevelLabel(area, shown)}
              </span>
            </>
          )}
        </ListboxButton>
        <ListboxOptions className="max-w-72 min-w-48">
          <div className="px-2 py-1 text-2xs text-description-muted">
            <div className="font-semibold">{POLICY_AREA_LABELS[area]}</div>
            <div className="whitespace-normal">
              {AREA_HINTS[area]}. Fewer decisions reach you as you go down.
            </div>
          </div>
          {POLICY_LEVELS.map((level) => {
            const unavailable =
              level === "automatic"
                ? automaticUnavailable(area, status)
                : undefined;
            return (
              <ListboxOption
                key={level}
                value={level}
                disabled={!!unavailable}
                data-testid={`policy-option-${area}-${level}`}
                className="items-start gap-1"
              >
                {(() => {
                  const OptionGlyph = LEVEL_GLYPHS[level];
                  return (
                    <OptionGlyph
                      className={`mt-0.5 h-3 w-3 shrink-0 ${LEVEL_TONES[level].text}`}
                      aria-hidden="true"
                    />
                  );
                })()}
                <div className="flex flex-col">
                  <span className={LEVEL_TONES[level].text}>
                    {policyLevelLabel(area, level)}
                  </span>
                  <span className="text-2xs whitespace-normal text-description-muted">
                    {unavailable
                      ? `Not available. ${unavailable}`
                      : POLICY_LEVEL_DESCRIPTIONS[area][level]}
                  </span>
                </div>
                <CheckIcon
                  className={`ml-auto h-3 w-3 shrink-0 ${shown === level ? "" : "opacity-0"}`}
                />
              </ListboxOption>
            );
          })}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}

/** The preset picker: a shortcut that sets all five areas at once. */
export function PresetSelect() {
  const dispatch = useAppDispatch();
  const levels = useAppSelector((s) => s.ui.policyLevels);
  const preset = presetOf(levels);
  const top = POLICY_AREAS.some((a) => levels[a] === "yolo");

  return (
    <Listbox
      value={preset ?? "custom"}
      onChange={(name: string) => {
        if (name in POLICY_PRESETS) {
          void dispatch(
            applyPolicyPreset(
              POLICY_PRESETS[name as keyof typeof POLICY_PRESETS].levels,
            ),
          );
        }
      }}
    >
      <div className="relative" title="Presets set all five areas at once">
        <ListboxButton
          data-testid="policy-preset"
          className={`flex-none gap-1 rounded-full border-none px-1.5 py-0.5 transition-colors duration-200 hover:brightness-110 ${
            top ? "bg-error/20 text-error" : "bg-lightgray/20 text-description"
          }`}
        >
          {top && <ExclamationTriangleIcon className="h-2.5 w-2.5" />}
          <span>{preset ? POLICY_PRESETS[preset].label : "Custom"}</span>
          <ChevronDownIcon className="h-2 w-2 shrink-0" aria-hidden="true" />
        </ListboxButton>
        <ListboxOptions className="max-w-64 min-w-40">
          {POLICY_PRESET_ORDER.map((name) => (
            <ListboxOption
              key={name}
              value={name}
              data-testid={`policy-preset-${name}`}
              className="items-start gap-1"
            >
              <div className="flex flex-col">
                <span className={name === "yolo" ? "text-error" : ""}>
                  {POLICY_PRESETS[name].label}
                </span>
                <span className="text-2xs whitespace-normal text-description-muted">
                  {POLICY_PRESETS[name].description}
                </span>
              </div>
              <CheckIcon
                className={`ml-auto h-3 w-3 shrink-0 ${preset === name ? "" : "opacity-0"}`}
              />
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}

/**
 * The toolbar: a preset picker and one dropdown for each of the five areas.
 * Below the xs breakpoint only the preset picker is shown, because five more
 * targets do not fit; every area is still reachable in Settings > Tools.
 */
export function PolicyControls() {
  return (
    <div
      className="flex flex-row items-center gap-1"
      data-testid="policy-controls"
    >
      <PresetSelect />
      <div className="hidden flex-row items-center gap-1 xs:flex">
        {POLICY_AREAS.map((area) => (
          <AreaLevelSelect key={area} area={area} variant="icon" />
        ))}
      </div>
    </div>
  );
}

/**
 * Shown above the input for as long as any area is at YOLO. It has no close
 * button on purpose: the way to remove it is to leave YOLO.
 */
export function YoloBanner() {
  const dispatch = useAppDispatch();
  const areas = useAppSelector(selectYoloAreas);
  if (areas.length === 0) return null;
  const names = areas
    .map((a) => `${POLICY_AREA_LABELS[a]} (${policyLevelLabel(a, "yolo")})`)
    .join(", ");
  return (
    <div
      role="alert"
      data-testid="yolo-banner"
      className="flex items-center gap-2 bg-error/15 px-2 py-0.5 text-2xs text-error"
    >
      <ExclamationTriangleIcon className="h-3 w-3 shrink-0" />
      <span className="flex-1">
        {names}: nothing asks. Deny rules, ask rules, protected paths and the
        safety check are ignored for these.
      </span>
      <button
        type="button"
        className="cursor-pointer border-none bg-transparent text-2xs text-error underline"
        onClick={() =>
          void dispatch(applyPolicyPreset(POLICY_PRESETS.careful.levels))
        }
      >
        Back to Careful
      </button>
    </div>
  );
}
