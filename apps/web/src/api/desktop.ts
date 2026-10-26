import createClient from "openapi-fetch";
import type { components, paths } from "./generated/schema";
import { compatibleFetch } from "./compatibility";

// The iframe always targets its own gateway, including through retained proxy Host.
export async function writeDesktopClipboard(text: string, signal: AbortSignal): Promise<void> {
  const api = createClient<paths>({ baseUrl: location.origin, fetch: compatibleFetch });
  const { response, error } = await api.POST("/v1/desktop/clipboard", { body: { text }, signal, cache: "no-store" });
  if (response.status !== 204) {
    const message = error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message : "The Mac clipboard could not be written.";
    throw new Error(message);
  }
}


export async function readDesktopDisplayTarget(signal: AbortSignal): Promise<components["schemas"]["DisplayTarget"] | null> {
  const api = createClient<paths>({ baseUrl: location.origin, fetch: compatibleFetch });
  const { data, error } = await api.GET("/v1/desktop/display", { signal, cache: "no-store" });
  if (error || !data) throw new Error("The Mac virtual display is unavailable.");
  return data.preferredDisplay ?? null;
}
