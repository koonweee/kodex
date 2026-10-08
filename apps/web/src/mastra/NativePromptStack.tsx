import { Alert, Box, Button, Checkbox, Group, Stack, Text, Textarea } from '@mantine/core';
import { Check, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { NativePrompt, PromptResponse } from '../../../../spikes/mastra-code-sdk/src/chat-prompts';
import { ApprovalCardFrame } from '../approvals/ApprovalCard';
import { LazyMarkdownContent } from '../timeline/rendererShared';

type PromptEntry = { prompt: NativePrompt; ownerTitle?: string };
type Respond = (response: PromptResponse) => Promise<unknown>;

export function NativePromptStack({ prompts, onRespond, onRefresh }: { prompts: PromptEntry[]; onRespond: Respond; onRefresh?: () => void }) {
  if (!prompts.length) return null;
  return <Stack gap="xs" className="kodex-thread-approvals kodex-thread-column">
    {prompts.map(entry => <NativePromptCard key={promptKey(entry.prompt)} {...entry} onRespond={onRespond} onRefresh={onRefresh} />)}
  </Stack>;
}

function promptKey(prompt: NativePrompt): string {
  if (prompt.kind === 'unsupported' && !prompt.target) return JSON.stringify([prompt.kind, prompt.toolCallId, prompt.toolName]);
  const target = prompt.target!;
  return JSON.stringify([prompt.kind, target.sessionId, target.threadId, target.resourceId, target.runId, target.toolCallId]);
}

function NativePromptCard({ prompt, ownerTitle, onRespond, onRefresh }: PromptEntry & { onRespond: Respond; onRefresh?: () => void }) {
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const responding = useRef(false);
  async function send(response: PromptResponse) {
    if (responding.current) return;
    responding.current = true; setPending(true); setError(null);
    try {
      await onRespond(response);
      // The native snapshot removes settled prompts. An acknowledgment alone
      // must not hide this card or make the same prompt actionable again.
    } catch (failure) {
      responding.current = false; setPending(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }
  const title = { question: 'Input requested', approval: 'Approval request', plan: 'Plan approval', unsupported: 'Unsupported request' }[prompt.kind];
  const owner = ownerTitle ? <Text size="xs" c="dimmed">From {ownerTitle}</Text> : null;
  const feedback = <>
    {pending ? <Text size="xs" role="status">Waiting for the agent to process this response…</Text> : null}
    {error ? <Alert color="red" role="alert">{error}</Alert> : null}
  </>;
  const markdown = (text: string) => <LazyMarkdownContent className="kodex-assistant-markdown" text={text} fallbackText={text} />;
  const action = (label: string, response: PromptResponse, danger = false, disabled = false) => <Button
    className="kodex-approval-action" data-approval-tone={danger ? 'danger' : 'positive'} size="xs"
    color={danger ? 'red' : undefined} variant={danger ? 'light' : 'filled'} disabled={pending || disabled}
    leftSection={danger ? <X size={14} /> : <Check size={14} />} onClick={() => { void send(response); }}>{label}</Button>;
  if (prompt.kind === 'unsupported') return <ApprovalCardFrame title={title}>
    {owner}<Text size="sm">{prompt.toolName}</Text><Text c="dimmed" size="sm">{prompt.reason}</Text>
  </ApprovalCardFrame>;
  const target = prompt.target;
  if (prompt.kind === 'approval') return <ApprovalCardFrame title={title}>
    {owner}<Text size="sm">{prompt.toolName}</Text>
    <Box className="kodex-approval-command" component="pre">{JSON.stringify(prompt.args, null, 2) ?? 'No arguments provided.'}</Box>
    <Group className="kodex-approval-actions" gap="xs" mt="sm">
      {action('Approve', { kind: 'approval', target, decision: 'approve' })}
      {action('Always allow category', { kind: 'approval', target, decision: 'always_allow_category' })}
      {action('Decline', { kind: 'approval', target, decision: 'decline' }, true)}
    </Group>{feedback}
  </ApprovalCardFrame>;
  if (prompt.kind === 'plan') return <ApprovalCardFrame title={title}>
    {owner}{prompt.title ? <Text size="sm" fw={600}>{prompt.title}</Text> : null}
    <Text size="sm">{prompt.path}</Text>
    {prompt.plan?.trim() ? markdown(prompt.plan) : <Text size="sm" c="dimmed">{prompt.previewError ?? 'Plan preview unavailable'}</Text>}
    <Textarea aria-label="Plan feedback" placeholder="Describe any changes…" value={draft} disabled={pending}
      autosize minRows={2} onChange={event => setDraft(event.currentTarget.value)} />
    <Group className="kodex-approval-actions" gap="xs" mt="sm">
      {action('Approve plan', { kind: 'plan', target, action: 'approved', previewVersion: prompt.previewVersion }, false, !prompt.plan?.trim() || !prompt.previewVersion)}
      {action('Request changes', { kind: 'plan', target, action: 'rejected', ...(prompt.previewVersion && { previewVersion: prompt.previewVersion }), ...(draft.trim() && { feedback: draft }) }, true)}
      {onRefresh ? <Button variant="default" size="xs" disabled={pending} onClick={() => { setError(null); onRefresh(); }}>Reload plan</Button> : null}
    </Group>{feedback}
  </ApprovalCardFrame>;
  const options = prompt.options ?? [];
  const multiple = options.length > 0 && prompt.selectionMode === 'multi_select';
  const answer = multiple ? [...options.filter((_, index) => selected.includes(index)).map(option => option.label), ...(draft.trim() ? [draft] : [])] : draft;
  return <ApprovalCardFrame title={title}>
    {owner}{markdown(prompt.question)}
    {options.length ? <Stack gap="xs">{options.map((option, index) => <Box key={index}>
      {multiple ? <Checkbox label={option.label} checked={selected.includes(index)} disabled={pending}
        onChange={event => { const checked = event.currentTarget.checked; setSelected(previous => checked ? [...previous, index] : previous.filter(value => value !== index)); }} />
        : <Button variant="default" disabled={pending} onClick={() => { void send({ kind: 'question', target, answer: option.label }); }}>{option.label}</Button>}
      {option.description ? <Text size="xs" c="dimmed">{option.description}</Text> : null}
    </Box>)}</Stack> : null}
    <form onSubmit={event => { event.preventDefault(); if (multiple ? answer.length : draft.trim()) void send({ kind: 'question', target, answer }); }}>
      <Textarea aria-label="Reply to question" placeholder={multiple ? 'Add another answer…' : 'Write your reply…'} value={draft} disabled={pending}
        autosize minRows={2} onChange={event => setDraft(event.currentTarget.value)} />
      <Group justify="flex-end" mt="xs"><Button type="submit" size="xs" loading={pending}
        disabled={pending || !(multiple ? answer.length : draft.trim())}>Send reply</Button></Group>
    </form>{feedback}
  </ApprovalCardFrame>;
}
