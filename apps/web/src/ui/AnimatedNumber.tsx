import { useReducedMotion } from "@mantine/hooks";
import { useState } from "react";
import "./animatedNumber.css";

// Keep at most one outgoing value; canonical bursts replace rather than queue rolls.
export function AnimatedNumber({ value }: { value: number | string }) {
  const reducedMotion = useReducedMotion();
  const [frame, setFrame] = useState<{ value: number | string; previous: number | string | null }>({ value, previous: null });
  if (frame.value !== value || (reducedMotion && frame.previous !== null)) {
    // Replace rather than queue transitions when canonical updates arrive rapidly.
    setFrame({ value, previous: !reducedMotion ? frame.value : null });
  }
  return (
    <span className="kodex-animated-number">
      <span
        key={value}
        className={frame.previous === null ? undefined : "kodex-animated-number-new"}
        onAnimationEnd={() => setFrame((current) => current.value === value ? { value, previous: null } : current)}
      >
        {value}
      </span>
      {frame.previous !== null && (
        <span key={`old-${value}`} className="kodex-animated-number-old" aria-hidden="true">{frame.previous}</span>
      )}
    </span>
  );
}
