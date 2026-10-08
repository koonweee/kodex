import { Select, Stack, Text, TextInput } from '@mantine/core';
import {
  nativeAutomationSchedulePreset,
  type NativeAutomationPreset,
  type NativeAutomationScheduleDraft,
} from './nativeAutomationForm';

const presets: Array<{ value: NativeAutomationPreset; label: string }> = [
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Daily at 09:00' },
  { value: 'weekdays', label: 'Weekdays at 09:00' },
  { value: 'custom', label: 'Custom cron' },
];

export function NativeAutomationScheduleFields({ value, onChange }: {
  value: NativeAutomationScheduleDraft;
  onChange: (value: NativeAutomationScheduleDraft) => void;
}) {
  return <Stack gap="sm">
    <Select label="Schedule" data={presets} value={value.preset} allowDeselect={false}
      onChange={preset => {
        if (presets.some(option => option.value === preset)) onChange(nativeAutomationSchedulePreset(value, preset as NativeAutomationPreset));
      }} />
    {value.preset === 'custom'
      ? <TextInput label="Cron expression" description="Minute, hour, day of month, month, day of week." required
          value={value.cron} onChange={event => onChange({ ...value, cron: event.currentTarget.value })} />
      : <Text size="xs" c="dimmed">Cron: {value.cron}</Text>}
    <TextInput label="Timezone" description="IANA timezone, such as Asia/Singapore or UTC." required
      value={value.timezone} onChange={event => onChange({ ...value, timezone: event.currentTarget.value })} />
  </Stack>;
}
