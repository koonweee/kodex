import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActivityCommandCount } from "./ActivityCommandCount";

describe("activity command count", () => {
  it("shows only the current count on mount and drops the old count after the transition", () => {
    const { rerender } = render(<ActivityCommandCount value={8} />);
    expect(screen.getAllByText("8")).toHaveLength(1);
    rerender(<ActivityCommandCount value={9} />);
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    fireEvent.animationEnd(screen.getByText("9"));
    expect(screen.queryByText("8")).not.toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
  });

  it("replaces an unfinished transition with the newest count and handles decreases immediately", () => {
    const { rerender } = render(<ActivityCommandCount value={9} />);
    rerender(<ActivityCommandCount value={10} />);
    rerender(<ActivityCommandCount value={14} />);
    expect(screen.queryByText("9")).not.toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    rerender(<ActivityCommandCount value={2} />);
    expect(screen.queryByText("10")).not.toBeInTheDocument();
    expect(screen.queryByText("14")).not.toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
