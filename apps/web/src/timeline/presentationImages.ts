import type { TimelineImage } from "./state";
import { payloadRecord, stringValue } from "./presentationShared";

export function payloadImages(payload: unknown): TimelineImage[] {
  const images: TimelineImage[] = [];
  for (const value of candidateImageContainers(payload)) {
    collectImages(value, images);
  }
  return dedupeImages(images);
}

export function mergeImages(existing?: TimelineImage[], incoming?: TimelineImage[]) {
  return dedupeImages([...(existing ?? []), ...(incoming ?? [])]);
}

function candidateImageContainers(payload: unknown): unknown[] {
  const record = payloadRecord(payload);
  const item = payloadRecord(record?.item);
  return [payload, record?.content, record?.input, item, item?.content, item?.input].filter(Boolean);
}

function collectImages(value: unknown, images: TimelineImage[]) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectImages(entry, images);
    }
    return;
  }
  const record = payloadRecord(value);
  if (!record) {
    return;
  }
  const type = stringValue(record.type).toLowerCase();
  const url = stringValue(record.url) || stringValue(record.imageUrl) || stringValue(record.image_url);
  const path = stringValue(record.path);
  const hasImageType = ["image", "inputimage", "input_image", "localimage", "local_image"].includes(type);
  if (type && !hasImageType && !url) {
    return;
  }
  if ((hasImageType || url || path) && (url || path)) {
    images.push({ url: url || undefined, path: path || undefined });
  }
}

function dedupeImages(images: TimelineImage[]): TimelineImage[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = image.url || image.path;
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
