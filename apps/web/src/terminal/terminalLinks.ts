export function openTerminalLink(_event: MouseEvent, uri: string) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;
  window.open(uri, "_blank", "noopener,noreferrer");
}
