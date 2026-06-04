import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

const GENERATED_UI_MIN_WIDTH = 360;
const GENERATED_UI_FALLBACK_MAX_WIDTH = 720;
const GENERATED_UI_MAX_WIDTH_RATIO = 0.75;
const GENERATED_UI_CHAT_MIN_WIDTH = 320;
const GENERATED_UI_RESIZE_HANDLE_WIDTH = 4;
const GENERATED_UI_DEFAULT_WIDTH = 520;
const GENERATED_UI_RESIZE_STEP = 32;

function maxGeneratedUiWidth(workspaceWidth: number | null) {
  if (!workspaceWidth) {
    return GENERATED_UI_FALLBACK_MAX_WIDTH;
  }
  const ratioMaxWidth = Math.floor(workspaceWidth * GENERATED_UI_MAX_WIDTH_RATIO);
  const chatPreservingMaxWidth = Math.floor(
    workspaceWidth - GENERATED_UI_CHAT_MIN_WIDTH - GENERATED_UI_RESIZE_HANDLE_WIDTH,
  );
  return Math.max(GENERATED_UI_MIN_WIDTH, Math.min(ratioMaxWidth, chatPreservingMaxWidth));
}

function clampGeneratedUiWidth(width: number, maxWidth: number) {
  return Math.min(maxWidth, Math.max(GENERATED_UI_MIN_WIDTH, Math.round(width)));
}

export function useGeneratedUiResize() {
  const [generatedUiWidth, setGeneratedUiWidth] = useState(GENERATED_UI_DEFAULT_WIDTH);
  const [workspaceElement, setGeneratedUiWorkspaceElement] = useState<HTMLDivElement | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState<number | null>(null);
  const [isGeneratedUiResizing, setIsGeneratedUiResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const generatedUiMaxWidth = maxGeneratedUiWidth(workspaceWidth);

  useEffect(() => {
    if (!workspaceElement) {
      setWorkspaceWidth(null);
      return;
    }

    function updateWorkspaceWidth() {
      const width = Math.round(workspaceElement?.getBoundingClientRect().width ?? 0);
      setWorkspaceWidth(width > 0 ? width : null);
    }

    updateWorkspaceWidth();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateWorkspaceWidth);
      observer.observe(workspaceElement);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateWorkspaceWidth);
    return () => window.removeEventListener("resize", updateWorkspaceWidth);
  }, [workspaceElement]);

  useEffect(() => {
    setGeneratedUiWidth((width) => clampGeneratedUiWidth(width, generatedUiMaxWidth));
  }, [generatedUiMaxWidth]);

  useEffect(() => {
    if (!isGeneratedUiResizing) {
      return;
    }

    function handlePointerMove(event: PointerEvent) {
      const start = resizeStart.current;
      if (!start) {
        return;
      }
      setGeneratedUiWidth(clampGeneratedUiWidth(start.width - (event.clientX - start.x), generatedUiMaxWidth));
    }

    function finishResize() {
      resizeStart.current = null;
      setIsGeneratedUiResizing(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
  }, [generatedUiMaxWidth, isGeneratedUiResizing]);

  function handleGeneratedUiResizePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    resizeStart.current = { x: event.clientX, width: generatedUiWidth };
    setIsGeneratedUiResizing(true);
  }

  function handleGeneratedUiResizeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setGeneratedUiWidth((width) => clampGeneratedUiWidth(width + GENERATED_UI_RESIZE_STEP, generatedUiMaxWidth));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setGeneratedUiWidth((width) => clampGeneratedUiWidth(width - GENERATED_UI_RESIZE_STEP, generatedUiMaxWidth));
    } else if (event.key === "Home") {
      event.preventDefault();
      setGeneratedUiWidth(GENERATED_UI_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setGeneratedUiWidth(generatedUiMaxWidth);
    }
  }

  return {
    generatedUiMaxWidth,
    generatedUiMinWidth: GENERATED_UI_MIN_WIDTH,
    generatedUiWidth,
    handleGeneratedUiResizeKeyDown,
    handleGeneratedUiResizePointerDown,
    isGeneratedUiResizing,
    setGeneratedUiWorkspaceElement,
  };
}
