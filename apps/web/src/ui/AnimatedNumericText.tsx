import { VisuallyHidden } from "@mantine/core";
import { AnimatedNumber } from "./AnimatedNumber";

/** Numeric UI copy only: leave user content, identifiers and editable fields plain. */
export function AnimatedNumericText({ text }: { text: string }) {
  const parts = text.split(/(\d+(?:[.,]\d+)*)/g);
  if (parts.length === 1) return <>{text}</>;
  if (parts.length === 3 && !parts[0] && !parts[2]) return <AnimatedNumber value={parts[1]} />;
  return <>
    <VisuallyHidden>{text}</VisuallyHidden>
    <span aria-hidden="true">{parts.map((part, index) => index % 2
      // Anchor from the right so seconds keep their slot when minutes/hours appear.
      ? <AnimatedNumber key={parts.length - index} value={part} /> : part)}</span>
  </>;
}
