# Timeline Rendering Feedback

QA pass in progress.

## 1. Assistant Markdown Message

- Type name: assistant markdown message
- What was emitted: A compact assistant markdown message with a heading, bullet list, inline code, and a local README link.
- Feedback: "loooks good, next"
- Obvious suspected UI/rendering issue: None reported.

## 2. User-Style Message Echo

- Type name: user-style message echo
- What was emitted: Not directly triggerable from an assistant prompt as a true user-role timeline item. The closest natural item was the user's previous message, "loooks good, next", noted as already visible in the UI.
- Feedback: "next"
- Obvious suspected UI/rendering issue: Not inspected; user chose to continue.

## 3. Reasoning Summary

- Type name: reasoning summary
- What was emitted: A brief reasoning summary explaining that prior feedback was recorded, the user-role echo was not directly triggerable, and the workflow was moving to the next type.
- Feedback: "next"
- Obvious suspected UI/rendering issue: None reported.

## 4. Command Execution

- Type name: command execution
- What was emitted: Ran `printf 'timeline command sample\n'`, producing one line of command output.
- Feedback: "nothing , next"
- Obvious suspected UI/rendering issue: None reported.

## 5. File Change

- Type name: file change
- What was emitted: Applied a small patch to add "QA pass in progress." near the top of this feedback file.
- Feedback: Instead of rendering a collapsed "update /Users/example/kodex/timeline-rendering-feedback.md" section, render a diff viewer if practical. User asked whether there is a good library to use.
- Obvious suspected UI/rendering issue: File change activity is too terse in the collapsed/summary rendering and does not expose the actual patch content for review.

## 6. Plan

- Type name: plan
- What was emitted: An assistant-rendered markdown plan with three numbered steps.
- Feedback: "i dont think thats a plan type message, but continue"
- Obvious suspected UI/rendering issue: The emitted item was normal assistant markdown, not the UI's native plan renderer/event type.

## 7. Image View From A Local PNG Path

- Type name: image view from a local PNG path
- What was emitted: Viewed `/Users/example/kodex/apps/web/public/favicon.png` at original detail.
- Feedback: "its fine, next"
- Obvious suspected UI/rendering issue: None reported.

## 8. Image Generation

- Type name: image generation
- What was emitted: Generated a small 512x512 QA test image with a white background, centered blue rounded square, and "QA" text.
- Feedback: "image generation looks good"
- Obvious suspected UI/rendering issue: None reported.

## 9. Markdown File Link To A Local `.md` Path

- Type name: markdown file link to a local `.md` path
- What was emitted: Assistant markdown linking to `/Users/example/kodex/timeline-rendering-feedback.md`.
- Feedback: "we will want to brainstorm some way to open the markdown in a markdown viewer/editor in a side pane from the right"
- Obvious suspected UI/rendering issue: Local markdown links currently render as links only; desired behavior is an in-app right-side markdown viewer/editor pane.

## 10. Warning

- Type name: warning
- What was emitted: A native internal warning event was not directly triggerable from a normal prompt. Closest natural action tried was a command that emitted `warning: timeline QA warning probe` to stderr and exited successfully.
- Feedback: "skip"
- Obvious suspected UI/rendering issue: Dedicated warning rendering remains unverified; stderr warning text likely renders as command output rather than a native warning timeline item.

## 11. Error

- Type name: error
- What was emitted: Ran `ls /Users/example/kodex/__timeline_qa_missing_file__`, producing a natural command failure with exit code 1.
- Feedback: "yeah it rendered as failed command, but without any failed indication (unlike succes)"
- Obvious suspected UI/rendering issue: Failed command executions do not show an explicit failed/error status indicator, while successful commands show a success indicator.

## 12. Review Mode Started/Finished

- Type name: review mode started/finished
- What was emitted: Not directly triggerable from a normal prompt unless a dedicated review-mode runtime event is exposed. A nearby assistant self-review text sample was offered but not used.
- Feedback: "skip"
- Obvious suspected UI/rendering issue: Dedicated review-mode marker rendering remains unverified.

## 13. Context Compaction Marker

- Type name: context compaction marker
- What was emitted: Not directly triggerable from a normal prompt. It usually appears only when the runtime automatically compacts conversation context.
- Feedback: "skip"
- Obvious suspected UI/rendering issue: Dedicated context compaction marker rendering remains unverified.

## 14. Unsupported/Debug Item

- Type name: unsupported/debug item
- What was emitted: Not directly triggerable from a normal prompt. These usually require a raw/debug event payload, unknown schema item, or runtime condition outside ordinary assistant actions.
- Feedback: "skip"
- Obvious suspected UI/rendering issue: Dedicated unsupported/debug item rendering remains unverified.
