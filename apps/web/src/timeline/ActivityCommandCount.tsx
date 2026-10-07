import { useReducedMotion } from "@mantine/hooks";
import { useState } from "react";
import "./activityCommandCount.css";

// Decorative only: ActivityGroupSummary exposes the complete current label once.
export function ActivityCommandCount({ value }: { value: number }) {
  const reducedMotion = useReducedMotion();
  const [frame, setFrame] = useState<{ value: number; previous: number | null }>({ value, previous: null });
  if (frame.value !== value || (reducedMotion && frame.previous !== null)) {
    // Replace rather than queue transitions when canonical updates arrive rapidly.
    setFrame({ value, previous: !reducedMotion && value > frame.value ? frame.value : null });
  }
  return (
    <span className="kodex-command-count" aria-hidden="true">
      <span
        key={value}
        className={frame.previous === null ? undefined : "kodex-command-count-new"}
        onAnimationEnd={() => setFrame((current) => current.value === value ? { value, previous: null } : current)}
      >
        {value}
      </span>
      {frame.previous !== null && (
        <span key={`old-${value}`} className="kodex-command-count-old">{frame.previous}</span>
      )}
    </span>
  );
}
