import { createHmac, randomBytes } from 'node:crypto';
import { ORPCError, EventPublisher } from '@orpc/server';
import { getAvailableThinkingLevelsForModel, isThinkingLevelSetting, type ThinkingLevelSetting } from '@mastra/code-sdk/thinking';
import type { AvailableModel } from '@mastra/core/agent-controller';
import { assertProfileActive, type SpikeProfile } from './profile.js';
import type { NativeSession, ProjectRuntime } from './runtime.js';
import { CHAT_FAST_SETTING } from './chat-fast.js';

export interface ChatSettingsPatch { modelId?: string; thinkingLevel?: ThinkingLevelSetting | null; fast?: boolean }
export interface ChatSettings {
  fast: boolean;
  modelId: string;
  thinkingLevel: ThinkingLevelSetting;
  thinkingLevelOverride: ThinkingLevelSetting | null;
  thinkingLevels: ThinkingLevelSetting[];
}
export interface DraftDefaults {
  epoch: string;
  revision: number;
  /** Opaque native-file version captured by the form, not fetched at submission. */
  version: string;
  modelId: string;
  thinkingLevel: ThinkingLevelSetting;
  thinkingLevels: ThinkingLevelSetting[];
}
export type ChatModel = Omit<AvailableModel, 'apiKeyEnvVar'> & { thinkingLevels: ThinkingLevelSetting[] };
const badSettings = () => new ORPCError('BAD_REQUEST', { message: 'Invalid model or thinking level.' });

/** Synchronous validation also protects direct service callers. */
export function validSettingsPatch(value: unknown, nullable = true): value is ChatSettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).some(key => key !== 'modelId' && key !== 'thinkingLevel' && key !== 'fast')) return false;
  if ('modelId' in patch && (typeof patch.modelId !== 'string' || !patch.modelId.trim() || patch.modelId.length > 256)) return false;
  if ('fast' in patch && (!nullable || typeof patch.fast !== 'boolean')) return false;
  if ('thinkingLevel' in patch && !(nullable && patch.thinkingLevel === null) && !isThinkingLevelSetting(patch.thinkingLevel)) return false;
  return true;
}
function serialize() {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(() => {}, () => {});
    return result;
  };
}

/** Native storage remains authoritative. Gates coordinate sparse browser writes;
 * they do not own a second settings store or execution defaults. SDK imports
 * that can initialize profile state are deferred until after profile activation.
 */
export function createNativeChatSettings(profile: SpikeProfile, epoch: string) {
  const globalGate = serialize();
  const versionKey = randomBytes(32);
  const fileVersion = (settings: unknown) => createHmac('sha256', versionKey).update(JSON.stringify(settings)).digest('hex');
  const conflict = () => new ORPCError('CONFLICT', { message: 'Defaults changed. Review the current settings before saving again.' });
  const gates = new WeakMap<NativeSession, ReturnType<typeof serialize>>();
  const publisher = new EventPublisher<{ changed: number }>({ maxBufferedEvents: 1 });
  let previousVersion: string | undefined;
  let revision = 0;
  const native = async () => {
    assertProfileActive(profile);
    const [settings, packs, gateway, openai] = await Promise.all([
      import('@mastra/code-sdk/onboarding/settings'), import('@mastra/code-sdk/onboarding/packs'),
      import('@mastra/code-sdk/agents/mastracode-gateway'), import('@mastra/code-sdk/providers/openai-codex'),
    ]);
    return { ...settings, ...packs, ...gateway, ...openai };
  };
  function thinkingModelId(sdk: Awaited<ReturnType<typeof native>>, modelId: string) {
    const prefix = `${sdk.MASTRACODE_GATEWAY_ID}/`;
    return sdk.stripMastraGatewayPrefix(modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId);
  }
  function effectiveLevel(sdk: Awaited<ReturnType<typeof native>>, modelId: string, level: ThinkingLevelSetting) {
    const id = thinkingModelId(sdk, modelId);
    if (!id.startsWith(sdk.OPENAI_PREFIX) || sdk.loadSettings(profile.settingsPath).customProviders?.some(provider => sdk.getCustomProviderId(provider.name) === 'openai')) return level;
    // Native OAuth applies a GPT-5 floor to off; native API-key mode omits it.
    const auth = sdk.getGlobalAuthStorage();
    auth.reload();
    if (level === 'off' && auth.get('openai-codex')?.type !== 'oauth') return level;
    return sdk.getEffectiveThinkingLevel(id.slice(sdk.OPENAI_PREFIX.length), level);
  }
  const withChat = <T>(session: NativeSession, operation: () => Promise<T>) => {
    let gate = gates.get(session);
    if (!gate) { gate = serialize(); gates.set(session, gate); }
    return gate(operation);
  };
  async function listModels(runtime: ProjectRuntime): Promise<ChatModel[]> {
    const sdk = await native();
    const providers = sdk.loadSettings(profile.settingsPath).customProviders;
    return (await runtime.controller.listAvailableModels()).map(({ apiKeyEnvVar: _, ...model }) => {
      // The SDK's own picker strips custom-provider gateway catalog prefixes
      // before persistence; its qualified catalog id is not a resolvable model.
      const id = sdk.stripMastraCodeCustomProviderPrefix(model.id, providers);
      return { ...model, id, thinkingLevels: getAvailableThinkingLevelsForModel(thinkingModelId(sdk, id)) };
    });
  }
  async function validate(runtime: ProjectRuntime, patch: ChatSettingsPatch, currentModel: string, currentFast = false) {
    if (!validSettingsPatch(patch)) throw badSettings();
    if (patch.modelId !== undefined && !(await listModels(runtime)).some(model => model.id === patch.modelId && model.hasApiKey)) throw badSettings();
    const modelId = patch.modelId ?? currentModel;
    const sdk = await native();
    const nativeId = thinkingModelId(sdk, modelId);
    if ((patch.fast ?? currentFast) && (!nativeId.startsWith(sdk.OPENAI_PREFIX) || sdk.loadSettings(profile.settingsPath).customProviders?.some(provider => sdk.getCustomProviderId(provider.name) === 'openai'))) {
      throw new ORPCError('BAD_REQUEST', { message: 'Fast responses are not supported by this native model. Turn Fast off before choosing another provider.' });
    }
    if (patch.thinkingLevel != null && !getAvailableThinkingLevelsForModel(nativeId).includes(patch.thinkingLevel)) throw badSettings();
  }
  async function readChat(session: NativeSession): Promise<ChatSettings> {
    const sdk = await native();
    const settings = sdk.loadSettings(profile.settingsPath);
    const modelId = session.model.get() ?? session.mode.resolve().defaultModelId ?? '';
    const override = session.state.get().thinkingLevel;
    const thinkingLevelOverride = isThinkingLevelSetting(override) ? override : null;
    return {
      modelId, thinkingLevelOverride,
      fast: (await session.thread.getSetting({ key: CHAT_FAST_SETTING })) === true,
      thinkingLevel: effectiveLevel(sdk, modelId, thinkingLevelOverride ?? sdk.resolveDefaultThinkingLevel(settings, session.mode.get()).level),
      thinkingLevels: getAvailableThinkingLevelsForModel(thinkingModelId(sdk, modelId)),
    };
  }
  async function readDefaults(runtime: ProjectRuntime): Promise<DraftDefaults> {
    const sdk = await native();
    const settings = sdk.loadSettings(profile.settingsPath);
    const mode = defaultMode(runtime);
    const modelId = sdk.resolveModelDefaults(settings, sdk.listBuiltinModePacks())[mode.id] ?? mode.defaultModelId ?? '';
    // A keyed digest makes this opaque even when native settings contain secrets.
    const version = fileVersion(settings);
    if (previousVersion !== undefined && previousVersion !== version) publisher.publish('changed', ++revision);
    previousVersion = version;
    return { epoch, revision, version, modelId, thinkingLevel: effectiveLevel(sdk, modelId, sdk.resolveDefaultThinkingLevel(settings, mode.id).level), thinkingLevels: getAvailableThinkingLevelsForModel(thinkingModelId(sdk, modelId)) };
  }
  function defaultMode(runtime: ProjectRuntime) {
    const modes = runtime.controller.listModes();
    const mode = modes.find(mode => mode.metadata?.default === true || mode.default === true) ?? modes.find(mode => mode.id === 'build') ?? modes[0];
    if (!mode) throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'No native chat mode is available.' });
    return mode;
  }
  return {
    listModels,
    validate,
    readChat: (session: NativeSession) => withChat(session, () => readChat(session)),
    async updateChat(runtime: ProjectRuntime, session: NativeSession, patch: ChatSettingsPatch) {
      return withChat(session, async () => {
        const current = await readChat(session);
        await validate(runtime, patch, current.modelId, current.fast);
        if (patch.modelId !== undefined) await session.model.switch({ modelId: patch.modelId });
        if ('thinkingLevel' in patch) await session.state.set({ thinkingLevel: patch.thinkingLevel ?? undefined });
        if (patch.fast !== undefined) await session.thread.setSetting({ key: CHAT_FAST_SETTING, value: patch.fast });
        // Native setters can swallow persistence errors. Never report a saved
        // setting until the native row confirms the supplied sparse fields.
        const thread = await runtime.controller.queryThreadById({ threadId: session.thread.requireId() });
        if (!thread || (patch.fast !== undefined && thread.metadata?.[CHAT_FAST_SETTING] !== patch.fast) || (patch.modelId !== undefined && thread.metadata?.[`modeModelId_${session.mode.get()}`] !== patch.modelId) || ('thinkingLevel' in patch && thread.metadata?.thinkingLevel !== (patch.thinkingLevel ?? undefined))) {
          throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Chat settings could not be saved.' });
        }
        if (patch.fast !== undefined) session.emit({ type: 'display_state_changed', displayState: session.displayState.get() });
      });
    },
    getDefaults: (runtime: ProjectRuntime) => globalGate(() => readDefaults(runtime)),
    async updateDefaults(runtime: ProjectRuntime, version: string, patch: ChatSettingsPatch) {
      return globalGate(async () => {
        if (typeof version !== 'string' || !validSettingsPatch(patch, false)) throw badSettings();
        const current = await readDefaults(runtime);
        if (version !== current.version) throw conflict();
        await validate(runtime, patch, current.modelId);
        const sdk = await native();
        const settings = sdk.loadSettings(profile.settingsPath);
        // Validation can yield to external native CLI/config writes. Capture the
        // file again and fence the displayed version immediately before the
        // synchronous sparse save, preserving any intervening edit.
        if (fileVersion(settings) !== version) throw conflict();
        const mode = defaultMode(runtime);
        if (patch.modelId !== undefined) {
          // Native explicit mode defaults replace the selected pack while
          // retaining the pack's other resolved modes.
          settings.models.modeDefaults = { ...sdk.resolveModelDefaults(settings, sdk.listBuiltinModePacks()), [mode.id]: patch.modelId };
          settings.models.activeModelPackId = null;
        }
        if (patch.thinkingLevel !== undefined && patch.thinkingLevel !== null) settings.models.modeThinkingDefaults[mode.id] = patch.thinkingLevel;
        sdk.saveSettings(settings, profile.settingsPath);
        const saved = await readDefaults(runtime);
        if ((patch.modelId !== undefined && saved.modelId !== patch.modelId) || (patch.thinkingLevel != null && sdk.resolveDefaultThinkingLevel(sdk.loadSettings(profile.settingsPath), mode.id).level !== patch.thinkingLevel)) throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Draft defaults could not be saved.' });
        return saved;
      });
    },
    async *watchDefaults(runtime: ProjectRuntime, signal: AbortSignal): AsyncGenerator<DraftDefaults, void> {
      const changes = publisher.subscribe('changed', { signal });
      try {
        let current = await globalGate(() => readDefaults(runtime));
        yield current;
        for await (const next of changes) {
          if (next <= current.revision) continue;
          current = await globalGate(() => readDefaults(runtime));
          yield current;
        }
      } finally { await changes.return(); }
    },
  };
}
