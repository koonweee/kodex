import type { Approval, ApprovalResponse, ThreadSubagentSummary } from "../api/client";
import { AsyncQuestionAnswersProvider } from "../composer/AsyncQuestionReplyProvider";
import type { MarkdownPreviewRequest } from "../files/types";
import type { ImageLightboxImage } from "../images/types";
import { TimelineView } from "../timeline/TimelineView";
import { useReadonlyThreadTimeline } from "../timeline/useReadonlyThreadTimeline";
import { SubagentViewerView } from "./SubagentViewerView";

const EMPTY_APPROVALS: Approval[] = [];
const noopApprovalDecision = (_approval: Approval, _decision: ApprovalResponse) => {};
const noopReady = () => {};

export function SubagentThreadViewer(props: {
  imagePreviewUrlsByPath: Record<string, string>;
  onError: (error: unknown) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  onSelectSubagent: (threadId: string) => void;
  selectedSubagentId: string | null;
  showDebugEvents: boolean;
  subagents: ThreadSubagentSummary[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  error: Error | null;
  onReload: () => void;
}) {
  const selectedSubagent = props.subagents.find(entry => entry.id === props.selectedSubagentId) ?? props.subagents[0] ?? null;
  const { isLoading, scrollParentElement, setScrollParentElement, timeline, timelineEntry } = useReadonlyThreadTimeline({
    onError: props.onError, threadId: selectedSubagent?.id ?? null,
  });
  return <SubagentViewerView {...props} isLoading={isLoading} timelinePhase={timelineEntry.phase} scrollRef={setScrollParentElement}>
    <AsyncQuestionAnswersProvider items={timeline.items}><TimelineView
      approvals={EMPTY_APPROVALS}
      imagePreviewUrlsByPath={props.imagePreviewUrlsByPath}
      onApprovalDecision={noopApprovalDecision}
      onImageOpen={props.onImageOpen}
      onMarkdownOpen={props.onMarkdownOpen}
      onReady={noopReady}
      scrollParentElement={scrollParentElement}
      showDebug={props.showDebugEvents}
      threadId={selectedSubagent?.id}
      timeline={timeline}
    /></AsyncQuestionAnswersProvider>
  </SubagentViewerView>;
}
