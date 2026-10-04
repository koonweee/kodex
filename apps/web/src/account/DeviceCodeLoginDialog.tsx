import { Alert, Button, CopyButton, Group, Modal, Stack, Text, TextInput } from "@mantine/core";

import type { useDeviceCodeLogin } from "./useDeviceCodeLogin";

export function DeviceCodeLoginDialog({ flow }: { flow: ReturnType<typeof useDeviceCodeLogin> }) {
  return (
    <Modal
      opened={flow.opened}
      onClose={flow.close}
      title="Sign in with ChatGPT"
      closeOnClickOutside={false}
      closeOnEscape={!flow.busy}
      withCloseButton={!flow.busy}
      size="sm"
    >
      <Stack>
        {flow.error ? <Alert color="red" role="alert">{flow.error}</Alert> : null}
        {flow.login ? (
          <>
            <Text>Open the sign-in page, then enter this one-time code.</Text>
            <TextInput label="One-time code" value={flow.login.userCode} readOnly />
            <Group>
              <Button component="a" href={flow.login.verificationUrl} target="_blank" rel="noreferrer">
                Open sign-in page
              </Button>
              <CopyButton value={flow.login.userCode}>
                {({ copied, copy }) => <Button variant="default" onClick={copy}>{copied ? "Copied" : "Copy code"}</Button>}
              </CopyButton>
            </Group>
            <Text role="status" size="sm">Waiting for sign-in…</Text>
          </>
        ) : flow.busy ? <Text role="status">Requesting a sign-in code…</Text> : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={flow.close} disabled={flow.busy}>
            {flow.login ? "Cancel sign-in" : "Close"}
          </Button>
          {!flow.login && !flow.busy ? <Button onClick={flow.start}>Try again</Button> : null}
        </Group>
      </Stack>
    </Modal>
  );
}
