import type { AuthStorage } from '@mastra/code-sdk/auth/storage';

/** The external Mastra host must register the same native gateways as CodeSDK's
 * standalone controller. Its mount arguments currently omit that registry. */
export async function createHostModelGateways(settingsPath: string, authStorage: AuthStorage) {
  const [{ createMastraCodeGateway }, { createAmazonBedrockGateway }, settings] = await Promise.all([
    import('@mastra/code-sdk/agents/model'),
    import('@mastra/code-sdk/providers/amazon-bedrock-gateway'),
    import('@mastra/code-sdk/onboarding/settings'),
  ]);
  const profile = settings.loadSettings(settingsPath);
  const code = createMastraCodeGateway({
    settingsPath,
    mastraGatewayBaseUrl: (process.env.MASTRA_GATEWAY_URL ?? profile.memoryGateway?.baseUrl ?? settings.MASTRA_GATEWAY_DEFAULT_URL).replace(/\/+$/, '').replace(/\/v1$/, ''),
    mastraGatewayApiKey: process.env.MASTRA_GATEWAY_API_KEY ?? authStorage.getStoredApiKey(settings.MASTRA_GATEWAY_PROVIDER),
    routeThroughMastraGateway: false,
  });
  const bedrock = createAmazonBedrockGateway();
  return { [code.id]: code, [bedrock.id]: bedrock };
}
