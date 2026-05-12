import { Button, Group, PasswordInput, Stack, Text } from "@mantine/core";

export type SecretAction = {
  mode: "unchanged" | "replace" | "clear";
  value: string;
};

type StoredSecretRowsProps = {
  actions: Record<string, SecretAction>;
  label: string;
  onChange: (actions: Record<string, SecretAction>) => void;
};

export function StoredSecretRows({ actions, label, onChange }: StoredSecretRowsProps) {
  const entries = Object.entries(actions);
  if (entries.length === 0) {
    return null;
  }
  return (
    <Stack gap={6}>
      <Text c="dimmed" size="xs">
        {label}
      </Text>
      {entries.map(([key, action]) => (
        <Stack gap={6} key={key}>
          <Group gap={8} justify="space-between" wrap="wrap">
            <Group gap={6} wrap="nowrap">
              <Text fw={650} size="sm">
                {key}
              </Text>
              <Text c="dimmed" size="xs">
                {action.mode === "clear" ? "Will clear" : action.mode === "replace" ? "Will replace" : "Stored value"}
              </Text>
            </Group>
            <Group gap={6} wrap="nowrap">
              <Button onClick={() => onChange({ ...actions, [key]: { mode: "replace", value: action.value } })} size="compact-xs" type="button" variant="subtle">
                Replace
              </Button>
              <Button onClick={() => onChange({ ...actions, [key]: { mode: "clear", value: "" } })} size="compact-xs" type="button" variant="subtle">
                Clear
              </Button>
            </Group>
          </Group>
          {action.mode === "replace" ? (
            <PasswordInput
              aria-label={`Replacement value for ${key}`}
              onChange={(event) => onChange({ ...actions, [key]: { mode: "replace", value: event.currentTarget.value } })}
              placeholder="New value"
              value={action.value}
            />
          ) : null}
        </Stack>
      ))}
    </Stack>
  );
}
