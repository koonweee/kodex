import { Box, Skeleton } from "@mantine/core";

export function TimelineLoadingSkeleton() {
  return (
    <Box
      aria-busy="true"
      aria-label="Loading thread timeline"
      className="kodex-timeline-loading kodex-thread-column"
      role="status"
    >
      <SkeletonUserBubble lines={["full", "short"]} />
      <Box aria-hidden="true" className="kodex-timeline-skeleton-divider" />
      <SkeletonAssistantBlock lines={["long", "medium", "short", "medium", "tiny"]} />
    </Box>
  );
}

function SkeletonUserBubble({ lines }: { lines: SkeletonLineWidth[] }) {
  return (
    <Box aria-hidden="true" className="kodex-timeline-skeleton-row kodex-timeline-skeleton-user">
      <Box className="kodex-timeline-skeleton-user-bubble">
        {lines.map((line, index) => (
          <Skeleton
            className="kodex-timeline-skeleton-user-line"
            data-line-width={line}
            key={`${line}-${index}`}
            radius="xl"
          />
        ))}
      </Box>
    </Box>
  );
}

function SkeletonAssistantBlock({ lines }: { lines: SkeletonLineWidth[] }) {
  return (
    <Box aria-hidden="true" className="kodex-timeline-skeleton-row kodex-timeline-skeleton-assistant">
      {lines.map((line, index) => (
        <Skeleton
          className="kodex-timeline-skeleton-assistant-line"
          data-line-width={line}
          key={`${line}-${index}`}
          radius="xl"
        />
      ))}
    </Box>
  );
}

type SkeletonLineWidth = "full" | "long" | "medium" | "short" | "tiny";
