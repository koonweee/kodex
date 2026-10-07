/** Presentation only; backend-native payloads and write versions stay in adapters. */
export interface QueueRowView { id: string; input: unknown[]; attachmentCount: number; canSteer: boolean; disabled?: boolean; editDisabled?: boolean }
export interface QueueRecoveryView { id: string; input: unknown[]; status: 'uncertain' | 'recoverable'; savedInput?: unknown; error?: string | null }
export interface QueueController {
  rows: QueueRowView[]; recovery: QueueRecoveryView[]; busy: boolean; error: string | null;
  partial: boolean; hasPendingInput?: boolean; reorderDisabled?: boolean; version?: string;
  reload: () => void; steerFirst: () => boolean;
  edit: (row: QueueRowView, input: unknown[]) => Promise<boolean>;
  reorder: (ids: string[]) => Promise<boolean>;
  steer: (row: QueueRowView) => Promise<boolean>;
  remove: (row: QueueRowView) => Promise<boolean>;
  reconcile: (row: QueueRecoveryView) => Promise<boolean>;
  dismiss: (row: QueueRecoveryView) => Promise<boolean>;
}
