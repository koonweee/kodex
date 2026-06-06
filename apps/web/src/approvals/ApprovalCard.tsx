import { Box, Button, Group, Stack, Text } from "@mantine/core";
import { Check, X } from "lucide-react";
import type { ReactNode } from "react";

import type { Approval, ApprovalResponse } from "../api/client";
import {
  approvalParsedActions,
  approvalPermissionRule,
  approvalReason,
  approvalServerName,
  approvalSubject,
  approvalTitle,
  normalizedApprovalMethod,
} from "./payload";
import {
  approvalActionSpecs,
  type ApprovalActionIcon,
  type ApprovalActionSpec,
} from "./actions";

export type ApprovalAction = Omit<ApprovalActionSpec, "icon"> & {
  icon: ReactNode;
};

export function ApprovalCard({
  approval,
  onDecision,
}: {
  approval: Approval;
  onDecision: (approval: Approval, decision: ApprovalResponse) => void;
}) {
  const actions = approvalActions(approval);
  const parsedActions = approvalParsedActions(approval);
  const subject = approvalSubject(approval);
  const reason = approvalReason(approval);
  const permissionRule = approvalPermissionRule(approval);
  const serverName = approvalServerName(approval);
  const isCommandApproval = normalizedApprovalMethod(approval.method) === "command";

  return (
    <Box className="kodex-approval-card">
      <Text fw={700} size="sm">
        {approvalTitle(approval)}
      </Text>
      {serverName ? (
        <Text size="sm">
          Server: <strong>{serverName}</strong>
        </Text>
      ) : null}
      {reason ? (
        <Text c="dimmed" size="xs">
          Reason: {reason}
        </Text>
      ) : null}
      {permissionRule ? (
        <Text c="dimmed" size="xs">
          Permission rule: {permissionRule}
        </Text>
      ) : null}
      {subject ? (
        isCommandApproval ? (
          <Box className="kodex-approval-command" component="code">
            $ {subject}
          </Box>
        ) : (
          <Text size="sm">{subject}</Text>
        )
      ) : null}
      <ParsedApprovalActions actions={parsedActions} />
      <ApprovalActionButtons approval={approval} actions={actions} onDecision={onDecision} />
    </Box>
  );
}

export function ThreadApprovalStack({
  approvals,
  onDecision,
}: {
  approvals: Approval[];
  onDecision: (approval: Approval, decision: ApprovalResponse) => void;
}) {
  return (
    <Stack gap="xs" className="kodex-thread-approvals kodex-thread-column">
      {approvals.map((approval) => (
        <ApprovalCard approval={approval} key={approval.id} onDecision={onDecision} />
      ))}
    </Stack>
  );
}

function approvalActions(approval: Approval): ApprovalAction[] {
  return approvalActionSpecs(approval).map(renderableApprovalAction);
}

function ParsedApprovalActions({ actions }: { actions: string[] }) {
  if (actions.length === 0) {
    return null;
  }

  return (
    <Stack gap={4} mt="xs">
      {actions.map((action) => (
        <Text c="dimmed" key={action} size="xs">
          {action}
        </Text>
      ))}
    </Stack>
  );
}

function ApprovalActionButtons({
  actions,
  approval,
  onDecision,
}: {
  actions: ApprovalAction[];
  approval: Approval;
  onDecision: (approval: Approval, decision: ApprovalResponse) => void;
}) {
  return (
    <Group className="kodex-approval-actions" gap="xs" mt="sm">
      {actions.map((action) => (
        <Button
          aria-label={action.ariaLabel}
          className="kodex-approval-action"
          color={action.color}
          data-approval-tone={approvalActionTone(action)}
          key={action.label}
          leftSection={action.icon}
          size="xs"
          variant={action.variant ?? "filled"}
          onClick={() => onDecision(approval, action.response)}
        >
          {action.label}
        </Button>
      ))}
    </Group>
  );
}

function renderableApprovalAction(action: ApprovalActionSpec): ApprovalAction {
  return {
    ...action,
    icon: approvalActionIcon(action.icon),
  };
}

function approvalActionTone(action: ApprovalAction): "danger" | "neutral" | "positive" {
  if (action.color === "red") {
    return "danger";
  }
  if (action.color === "gray") {
    return "neutral";
  }
  return "positive";
}

function approvalActionIcon(icon: ApprovalActionIcon): ReactNode {
  if (icon === "x") {
    return <X size={14} />;
  }
  return <Check size={14} />;
}
