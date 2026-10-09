import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnimatedNumber } from "./AnimatedNumber";

describe("animated number", () => {
  it("shows only the current count on mount and drops the old count after the transition", () => {
    const { rerender } = render(<AnimatedNumber value={8} />);
    expect(screen.getAllByText("8")).toHaveLength(1);
    rerender(<AnimatedNumber value={9} />);
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    fireEvent.animationEnd(screen.getByText("9"));
    expect(screen.queryByText("8")).not.toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
  });

  it("rolls decreasing values for countdowns", () => {
    const { rerender } = render(<AnimatedNumber value={3} />);
    rerender(<AnimatedNumber value={2} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    fireEvent.animationEnd(screen.getByText("2"));
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });

  it("replaces an unfinished transition with the newest count and rolls decreases", () => {
    const { rerender } = render(<AnimatedNumber value={9} />);
    rerender(<AnimatedNumber value={10} />);
    rerender(<AnimatedNumber value={14} />);
    expect(screen.queryByText("9")).not.toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    rerender(<AnimatedNumber value={2} />);
    expect(screen.queryByText("10")).not.toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    fireEvent.animationEnd(screen.getByText("2"));
    expect(screen.queryByText("14")).not.toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
