import type { Approval, ApprovalResponse } from "../api/client";
import { asRecord, stringValue } from "../shared/values";
import {
  approvalNetworkHost,
  approvalPermissions,
  normalizedApprovalMethod,
} from "./payload";

export type ApprovalActionIcon = "check" | "x";

export type ApprovalActionSpec = {
  ariaLabel: string;
  color?: string;
  icon: ApprovalActionIcon;
  label: string;
  response: ApprovalResponse;
  variant?: "filled" | "light" | "subtle";
};

export function approvalActionSpecs(approval: Approval): ApprovalActionSpec[] {
  const method = normalizedApprovalMethod(approval.method);

  if (method === "permissions") {
    return permissionsApprovalActions(approval);
  }
  if (method === "mcp_elicitation") {
    return mcpElicitationApprovalActions();
  }
  if (method === "app_surface_bridge") {
    return appSurfaceBridgeApprovalActions();
  }
  if (method === "tool_user_input") {
    return [
      {
        ariaLabel: "Submit answers",
        icon: "check",
        label: "Submit",
        response: { answers: defaultToolAnswers(approval.payload) },
      },
    ];
  }
  if (method === "command") {
    return commandApprovalActions(approval);
  }
  if (method === "file") {
    return fileChangeApprovalActions();
  }
  return [];
}

function appSurfaceBridgeApprovalActions(): ApprovalActionSpec[] {
  return [
    {
      ariaLabel: "Yes, allow this tool call",
      icon: "check",
      label: "Yes, allow this tool call",
      response: { decision: "accept" },
    },
    {
      ariaLabel: "No, block this tool call",
      color: "red",
      icon: "x",
      label: "No, block this tool call",
      response: { decision: "decline" },
      variant: "light",
    },
  ];
}

function commandApprovalActions(approval: Approval): ApprovalActionSpec[] {
  const payload = asRecord(approval.payload);
  return commandDecisions(approval).map((decision) => commandApprovalAction(decision, payload));
}

function commandApprovalAction(
  decision: Record<string, unknown>,
  payload: Record<string, unknown>,
): ApprovalActionSpec {
  const kind = stringValue(decision.kind);
  const networkContext = asRecord(payload.networkApprovalContext);
  const hasNetworkContext = Boolean(approvalNetworkHost(payload));
  const hasAdditionalPermissions = Object.keys(asRecord(payload.additionalPermissions)).length > 0;
  if (kind === "accept") {
    return {
      ariaLabel: hasNetworkContext ? "Yes, just this once" : "Yes, proceed",
      icon: "check",
      label: hasNetworkContext ? "Yes, just this once" : "Yes, proceed",
      response: { decision: "accept" },
    };
  }
  if (kind === "acceptForSession") {
    const label = hasNetworkContext
      ? "Yes, and allow this host for this conversation"
      : hasAdditionalPermissions
        ? "Yes, and allow these permissions for this session"
        : "Yes, and don't ask again for this command in this session";
    return {
      ariaLabel: label,
      icon: "check",
      label,
      response: { decision: "acceptForSession" },
      variant: "light",
    };
  }
  if (kind === "acceptWithExecpolicyAmendment") {
    const amendment = decision.execpolicy_amendment;
    const renderedPrefix = execPolicyAmendmentLabel(amendment);
    const label = `Yes, and don't ask again for commands that start with \`${renderedPrefix}\``;
    return {
      ariaLabel: label,
      icon: "check",
      label,
      response: {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: amendment,
          },
        },
      },
      variant: "light",
    };
  }
  if (kind === "applyNetworkPolicyAmendment") {
    const amendment = asRecord(decision.network_policy_amendment);
    const fallbackAmendment: Record<string, unknown> =
      Object.keys(networkContext).length > 0 ? { action: "allow", ...networkContext } : {};
    const policyAmendment: Record<string, unknown> =
      Object.keys(amendment).length > 0 ? amendment : fallbackAmendment;
    const action = stringValue(policyAmendment.action);
    const label =
      action === "deny"
        ? "No, and block this host in the future"
        : "Yes, and allow this host in the future";
    return {
      ariaLabel: label,
      color: action === "deny" ? "red" : undefined,
      icon: action === "deny" ? "x" : "check",
      label,
      response: {
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: policyAmendment,
          },
        },
      },
      variant: "light",
    };
  }
  if (kind === "decline") {
    return {
      ariaLabel: "No, continue without running it",
      color: "red",
      icon: "x",
      label: "No, continue without running it",
      response: { decision: "decline" },
      variant: "light",
    };
  }
  return {
    ariaLabel: "No, and tell Codex what to do differently",
    color: "gray",
    icon: "x",
    label: "No, and tell Codex what to do differently",
    response: { decision: "cancel" },
    variant: "subtle",
  };
}

function fileChangeApprovalActions(): ApprovalActionSpec[] {
  return [
    {
      ariaLabel: "Yes, proceed",
      icon: "check",
      label: "Yes, proceed",
      response: { decision: "accept" },
    },
    {
      ariaLabel: "Yes, and don't ask again for these files",
      icon: "check",
      label: "Yes, and don't ask again for these files",
      response: { decision: "acceptForSession" },
      variant: "light",
    },
    {
      ariaLabel: "No, and tell Codex what to do differently",
      color: "gray",
      icon: "x",
      label: "No, and tell Codex what to do differently",
      response: { decision: "cancel" },
      variant: "subtle",
    },
  ];
}

function permissionsApprovalActions(approval: Approval): ApprovalActionSpec[] {
  const permissions = approvalPermissions(approval);
  return [
    {
      ariaLabel: "Yes, grant these permissions for this turn",
      icon: "check",
      label: "Yes, grant these permissions for this turn",
      response: { permissions, scope: "turn" },
    },
    {
      ariaLabel: "Yes, grant for this turn with strict auto review",
      icon: "check",
      label: "Yes, grant for this turn with strict auto review",
      response: { permissions, scope: "turn", strictAutoReview: true },
      variant: "light",
    },
    {
      ariaLabel: "Yes, grant these permissions for this session",
      icon: "check",
      label: "Yes, grant these permissions for this session",
      response: { permissions, scope: "session" },
      variant: "light",
    },
    {
      ariaLabel: "No, continue without permissions",
      color: "red",
      icon: "x",
      label: "No, continue without permissions",
      response: { permissions: {}, scope: "turn" },
      variant: "light",
    },
  ];
}

function mcpElicitationApprovalActions(): ApprovalActionSpec[] {
  return [
    {
      ariaLabel: "Yes, provide the requested info",
      icon: "check",
      label: "Yes, provide the requested info",
      response: { action: "accept" },
    },
    {
      ariaLabel: "No, but continue without it",
      color: "red",
      icon: "x",
      label: "No, but continue without it",
      response: { action: "decline" },
      variant: "light",
    },
    {
      ariaLabel: "Cancel this request",
      color: "gray",
      icon: "x",
      label: "Cancel this request",
      response: { action: "cancel" },
      variant: "subtle",
    },
  ];
}

function commandDecisions(approval: Approval): Record<string, unknown>[] {
  const payload = asRecord(approval.payload);
  const availableDecisions = commandAvailableDecisions(payload.availableDecisions);
  if (availableDecisions.length > 0) {
    return availableDecisions;
  }

  if (approvalNetworkHost(payload)) {
    const decisions: Record<string, unknown>[] = [{ kind: "accept" }, { kind: "acceptForSession" }];
    const allowAmendment = networkPolicyAmendments(payload.proposedNetworkPolicyAmendments).find(
      (amendment) => stringValue(amendment.action) === "allow",
    );
    if (allowAmendment) {
      decisions.push({ kind: "applyNetworkPolicyAmendment", network_policy_amendment: allowAmendment });
    }
    decisions.push({ kind: "cancel" });
    return decisions;
  }

  if (Object.keys(asRecord(payload.additionalPermissions)).length > 0) {
    return [{ kind: "accept" }, { kind: "cancel" }];
  }

  const decisions: Record<string, unknown>[] = [{ kind: "accept" }];
  const execpolicyAmendment = execPolicyAmendmentValue(payload.proposedExecpolicyAmendment);
  if (execpolicyAmendment) {
    decisions.push({ kind: "acceptWithExecpolicyAmendment", execpolicy_amendment: execpolicyAmendment });
  }
  decisions.push({ kind: "cancel" });
  return decisions;
}

function commandAvailableDecisions(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.reduce<Record<string, unknown>[]>((decisions, item) => {
    if (typeof item === "string") {
      decisions.push({ kind: item });
      return decisions;
    }

    const record = asRecord(item);
    if (record.acceptWithExecpolicyAmendment) {
      const amendment = asRecord(record.acceptWithExecpolicyAmendment);
      decisions.push({
        kind: "acceptWithExecpolicyAmendment",
        execpolicy_amendment: amendment.execpolicy_amendment ?? amendment.proposed_execpolicy_amendment,
      });
      return decisions;
    }

    if (record.applyNetworkPolicyAmendment) {
      const amendment = asRecord(record.applyNetworkPolicyAmendment);
      decisions.push({
        kind: "applyNetworkPolicyAmendment",
        network_policy_amendment: amendment.network_policy_amendment,
      });
    }
    return decisions;
  }, []);
}

function defaultToolAnswers(payload: unknown): Record<string, { answers: string[] }> {
  const questions = asRecord(payload).questions;
  if (!Array.isArray(questions)) {
    return {};
  }

  return questions.reduce<Record<string, { answers: string[] }>>((answers, question) => {
    const record = asRecord(question);
    const id = stringValue(record.id);
    if (!id) {
      return answers;
    }
    const options = Array.isArray(record.options) ? record.options : [];
    const firstOption = asRecord(options[0]);
    const firstAnswer = stringValue(firstOption.label);
    answers[id] = { answers: firstAnswer ? [firstAnswer] : [] };
    return answers;
  }, {});
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function execPolicyAmendmentValue(value: unknown): string[] | null {
  const array = stringArray(value);
  return array.length > 0 ? array : null;
}

function execPolicyAmendmentLabel(value: unknown): string {
  const array = stringArray(value);
  if (array.length > 0) {
    return array.join(" ");
  }
  const record = asRecord(value);
  const command = stringValue(record.command);
  return command ?? "this prefix";
}

function networkPolicyAmendments(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item) => stringValue(item.action) && stringValue(item.host))
    : [];
}
