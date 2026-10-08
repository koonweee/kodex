import { expect, it } from 'vitest';
import { nativeAutomationScheduleDraft, nativeAutomationScheduleError, nativeAutomationSchedulePreset } from './nativeAutomationForm';

it('initializes new schedules in the chosen timezone and copies persisted custom calendar values', () => {
  expect(nativeAutomationScheduleDraft(null, 'Asia/Singapore')).toEqual({ cron: '0 9 * * *', timezone: 'Asia/Singapore', preset: 'daily' });
  const saved = { cron: '15 14 * * 2', timezone: 'America/New_York' };
  const draft = nativeAutomationScheduleDraft(saved, 'Asia/Singapore');
  expect(draft).toEqual({ ...saved, preset: 'custom' });
  draft.timezone = 'UTC';
  expect(saved.timezone).toBe('America/New_York');
  expect(nativeAutomationScheduleDraft({ cron: '0 * * * *', timezone: 'UTC' }).preset).toBe('hourly');
});

it('changes calendar presets without losing the timezone or mutating the previous draft', () => {
  const draft = nativeAutomationScheduleDraft({ cron: '15 14 * * 2', timezone: 'America/New_York' });
  expect(nativeAutomationSchedulePreset(draft, 'hourly')).toEqual({ cron: '0 * * * *', timezone: draft.timezone, preset: 'hourly' });
  expect(nativeAutomationSchedulePreset(draft, 'weekdays')).toEqual({ cron: '0 9 * * 1-5', timezone: draft.timezone, preset: 'weekdays' });
  expect(nativeAutomationSchedulePreset(draft, 'custom')).toEqual({ ...draft, preset: 'custom' });
  expect(draft.cron).toBe('15 14 * * 2');
});

it('requires cron and timezone while leaving native syntax validation to the backend', () => {
  const draft = nativeAutomationScheduleDraft(null, 'UTC');
  expect(nativeAutomationScheduleError({ ...draft, cron: ' ' })).toMatch(/cron/i);
  expect(nativeAutomationScheduleError({ ...draft, timezone: ' ' })).toMatch(/timezone/i);
  expect(nativeAutomationScheduleError({ ...draft, cron: '@daily', timezone: 'Saved/NativeZone' })).toBeNull();
});
