import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativePrompt, NativePromptTarget, PromptResponse } from '../../../../spikes/mastra-code-sdk/src/chat-prompts';
import { NativePromptStack } from './NativePromptStack';

const target: NativePromptTarget = { sessionId: 'session', threadId: 'child-thread', resourceId: 'resource', runId: 'run', toolCallId: 'repeated-call' };
const question: NativePrompt = { kind: 'question', target, question: 'Choose **deployment**', options: [{ label: 'Preview', description: 'Run a temporary preview' }, { label: 'Release' }] };
const stack = (prompts: Array<{ prompt: NativePrompt; ownerTitle?: string }>, onRespond: (response: PromptResponse) => Promise<unknown>) => <MantineProvider><NativePromptStack prompts={prompts} onRespond={onRespond} /></MantineProvider>;
afterEach(cleanup);
describe('native prompt cards', () => {
  it('renders native single choices without selecting a default and sends the actual label', async () => {
    const respond = vi.fn(async () => ({ accepted: true }));
    render(stack([{ prompt: question, ownerTitle: 'Scout' }], respond));
    expect(await screen.findByText('deployment')).toBeVisible();
    expect(screen.getByText('From Scout')).toBeVisible();
    expect(screen.getByText('Run a temporary preview')).toBeVisible();
    expect(respond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    expect(respond).toHaveBeenCalledExactlyOnceWith({ kind: 'question', target, answer: 'Release' });
  });
  it('sends a free-text answer unchanged without affecting another card draft', async () => {
    const respond = vi.fn(async () => ({ accepted: true }));
    const other: NativePrompt = { kind: 'question', target: { ...target, toolCallId: 'other' }, question: 'What next?' };
    render(stack([{ prompt: question }, { prompt: other }], respond));
    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'Unsent draft' } });
    fireEvent.change(inputs[1], { target: { value: '  Use <preview>& keep it raw  ' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Send reply' })[1]);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ kind: 'question', target: other.target, answer: '  Use <preview>& keep it raw  ' });
    expect(inputs[0]).toHaveValue('Unsent draft');
  });
  it('uses explicit multiple choices and an optional custom answer as a native array', () => {
    const respond = vi.fn(async () => ({ accepted: true }));
    render(stack([{ prompt: { ...question, selectionMode: 'multi_select' } }], respond));
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Release' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Preview' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A custom target' } });
    expect(respond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(respond).toHaveBeenCalledExactlyOnceWith({ kind: 'question', target, answer: ['Preview', 'Release', 'A custom target'] });
  });
  it('disables duplicate own responses and waits for canonical removal after acknowledgment', async () => {
    let finish!: (value: unknown) => void;
    const respond = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const view = render(stack([{ prompt: question }], respond));
    const choice = screen.getByRole('button', { name: 'Preview' });
    fireEvent.click(choice); fireEvent.click(choice);
    expect(respond).toHaveBeenCalledTimes(1); expect(choice).toBeDisabled();
    await act(async () => { finish({ accepted: true }); });
    expect(screen.getByText('Input requested')).toBeVisible();
    expect(choice).toBeDisabled(); expect(screen.getByRole('status')).toHaveTextContent('Waiting for the agent');
    view.rerender(stack([{ prompt: structuredClone(question) }], respond));
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    view.rerender(stack([], respond));
    expect(screen.queryByText('Input requested')).not.toBeInTheDocument();
  });
  it('preserves drafts on failure, requires explicit retry and resets a repeated tool id for a new native run', async () => {
    const respond = vi.fn(async () => { throw new Error('Request no longer pending'); });
    const view = render(stack([{ prompt: question }], respond));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request no longer pending');
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft');
    expect(respond).toHaveBeenCalledTimes(1);
    view.rerender(stack([{ prompt: structuredClone(question) }], respond));
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft');
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeEnabled();
    view.rerender(stack([{ prompt: { ...question, target: { ...target, runId: 'new-run' } } }], respond));
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(respond).toHaveBeenCalledTimes(1);
  });
  it('separates same-id child prompts through reorder and ignores a late failure for an obsolete run', async () => {
    let failOld!: (error: Error) => void;
    const respond = vi.fn(() => new Promise((_resolve, reject) => { failOld = reject; }));
    const other: NativePrompt = { ...question, target: { ...target, sessionId: 'other-session', threadId: 'other-child' } };
    const view = render(stack([{ prompt: question, ownerTitle: 'Scout' }, { prompt: other, ownerTitle: 'Builder' }], respond));
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Scout draft' } });
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'Builder draft' } });
    view.rerender(stack([{ prompt: other, ownerTitle: 'Builder' }, { prompt: question, ownerTitle: 'Scout' }], respond));
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('Builder draft');
    expect(screen.getAllByRole('textbox')[1]).toHaveValue('Scout draft');
    fireEvent.click(screen.getAllByRole('button', { name: 'Send reply' })[1]);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ kind: 'question', target, answer: 'Scout draft' });
    const replacement: NativePrompt = { ...question, target: { ...target, runId: 'successor' } };
    view.rerender(stack([{ prompt: other, ownerTitle: 'Builder' }, { prompt: replacement, ownerTitle: 'Scout' }], respond));
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'Successor draft' } });
    await act(async () => { failOld(new Error('Obsolete response failed')); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('Builder draft');
    expect(screen.getAllByRole('textbox')[1]).toHaveValue('Successor draft');
    expect(screen.getAllByRole('button', { name: 'Send reply' })[1]).toBeEnabled();
  });
  it('keeps an unavailable plan explicit and sends rejection feedback with native action names', async () => {
    const respond = vi.fn(async () => ({ accepted: true }));
    const plan: NativePrompt = { kind: 'plan', target, path: '.mastracode/plans/work.md' };
    render(stack([{ prompt: plan }], respond));
    expect(screen.getByText('.mastracode/plans/work.md')).toBeVisible();
    expect(screen.getByText('Plan preview unavailable')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Plan feedback' }), { target: { value: 'Keep <native> feedback' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(respond).toHaveBeenCalledExactlyOnceWith({ kind: 'plan', target, action: 'rejected', feedback: 'Keep <native> feedback' });
  });
  it('renders supplied plan Markdown and approves through the native plan response', async () => {
    const respond = vi.fn(async () => ({ accepted: true }));
    render(stack([{ prompt: { kind: 'plan', target, path: 'plan.md', title: 'Deployment plan', plan: '**Run** the checks.' } }], respond));
    expect(screen.getByText('Deployment plan')).toBeVisible();
    expect(await screen.findByText('Run')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    expect(respond).toHaveBeenCalledExactlyOnceWith({ kind: 'plan', target, action: 'approved' });
  });
  it.each(['approve', 'decline', 'always_allow_category'] as const)('uses the native %s approval action', decision => {
    const respond = vi.fn(async () => ({ accepted: true }));
    render(stack([{ prompt: { kind: 'approval', target, toolName: 'execute_command', args: { command: 'npm test' } }, ownerTitle: 'Builder' }], respond));
    expect(screen.getByText('execute_command')).toBeVisible(); expect(screen.getByText(/npm test/)).toBeVisible();
    const label = { approve: 'Approve', decline: 'Decline', always_allow_category: 'Always allow category' }[decision];
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(respond).toHaveBeenCalledExactlyOnceWith({ kind: 'approval', target, decision });
  });
  it('shows unsupported native prompts without inventing a response action', () => {
    const respond = vi.fn(async () => ({ accepted: true }));
    render(stack([{ prompt: { kind: 'unsupported', target: null, toolCallId: 'unknown', toolName: 'request_access', reason: 'No supported native response shape' } }], respond));
    expect(screen.getByText('request_access')).toBeVisible(); expect(screen.getByText('No supported native response shape')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument(); expect(respond).not.toHaveBeenCalled();
  });
});
