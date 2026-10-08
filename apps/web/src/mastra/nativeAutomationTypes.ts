import type { ChatClient } from './client';

export type NativeAutomation = Awaited<ReturnType<ChatClient['listAutomations']>>[number];
export type NativeAutomationInput = NonNullable<Parameters<ChatClient['createAutomation']>[0]>;
export type NativeAutomationRun = Awaited<ReturnType<ChatClient['listAutomationRuns']>>[number];
