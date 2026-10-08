export type NativeAutomationPreset = 'hourly' | 'daily' | 'weekdays' | 'custom';
export type NativeAutomationScheduleDraft = { cron: string; timezone: string; preset: NativeAutomationPreset };

const presetCron = { hourly: '0 * * * *', daily: '0 9 * * *', weekdays: '0 9 * * 1-5' } as const;

export function nativeAutomationScheduleDraft(
  saved?: Pick<NativeAutomationScheduleDraft, 'cron' | 'timezone'> | null,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
): NativeAutomationScheduleDraft {
  const cron = saved?.cron ?? presetCron.daily;
  const preset = (Object.keys(presetCron) as Array<keyof typeof presetCron>).find(key => presetCron[key] === cron) ?? 'custom';
  return { cron, timezone: saved?.timezone ?? timezone, preset };
}

export function nativeAutomationSchedulePreset(draft: NativeAutomationScheduleDraft, preset: NativeAutomationPreset): NativeAutomationScheduleDraft {
  return { ...draft, preset, cron: preset === 'custom' ? draft.cron : presetCron[preset] };
}

export function nativeAutomationScheduleError(draft: NativeAutomationScheduleDraft): string | null {
  if (!draft.cron.trim()) return 'Cron expression is required.';
  if (!draft.timezone.trim()) return 'Timezone is required.';
  return null;
}
