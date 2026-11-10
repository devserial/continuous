import {
  ChatBubbleLeftIcon,
  RocketLaunchIcon,
  SparklesIcon,
  SwatchIcon,
} from "@heroicons/react/24/outline";
import { LoopPhaseMark } from "../LoopPhaseMark";
import type { ModeEntry } from "../../redux/selectors/selectModeEntry";

interface ModeIconProps {
  mode: ModeEntry;
  className?: string;
}

export function ModeIcon({ mode, className: given }: ModeIconProps) {
  const className = given ?? "xs:h-3 xs:w-3 h-3 w-3";
  switch (mode) {
    case "agent":
      return <SparklesIcon className={className} />;
    case "plan":
      return <SwatchIcon className={className} />;
    case "chat":
      return <ChatBubbleLeftIcon className={className} />;
    case "background":
      return <RocketLaunchIcon className={className} />;
    case "loop":
      // The figure eight is twice as wide as it is tall
      return <LoopPhaseMark className={given} />;
  }
}
