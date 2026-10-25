import createClient from "openapi-fetch";
import type { paths } from "./generated/schema";
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
