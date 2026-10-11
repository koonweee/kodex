import type { PropsWithChildren } from "react";
import {
  render as testingRender,
  renderHook as testingRenderHook,
  type RenderHookOptions,
  type RenderOptions,
} from "@testing-library/react";

import { GatewayClientProvider } from "../api/GatewayClientContext";
import { createGatewayClient, type GatewayClient } from "../api/gatewayClient";

const defaultTestGatewayClient = createGatewayClient();

export function GatewayTestProvider({
  children,
  client = defaultTestGatewayClient,
}: PropsWithChildren<{ client?: GatewayClient }>) {
  return <GatewayClientProvider client={client}>{children}</GatewayClientProvider>;
}

export function gatewayTestWrapper({ children }: PropsWithChildren) {
  return <GatewayTestProvider>{children}</GatewayTestProvider>;
}

export function renderWithGateway(
  ui: Parameters<typeof testingRender>[0],
  options: RenderOptions = {},
) {
  const ExistingWrapper = options.wrapper;
  const wrapper = ({ children }: PropsWithChildren) => (
    <GatewayTestProvider>
      {ExistingWrapper ? <ExistingWrapper>{children}</ExistingWrapper> : children}
    </GatewayTestProvider>
  );
  return testingRender(ui, { ...options, wrapper });
}

export function renderHookWithGateway<Result, Props>(
  callback: (initialProps: Props) => Result,
  options: RenderHookOptions<Props> = {},
) {
  const ExistingWrapper = options.wrapper;
  const wrapper = ({ children }: PropsWithChildren) => (
    <GatewayTestProvider>
      {ExistingWrapper ? <ExistingWrapper>{children}</ExistingWrapper> : children}
    </GatewayTestProvider>
  );
  return testingRenderHook(callback, { ...options, wrapper });
}
