export type ImageCompositionState = "processing" | "success" | "failed";

export type ImageCompositionSnapshot = {
  state: ImageCompositionState;
  terminal: boolean;
  reason:
    | "explicit_failure_status_30"
    | "complete_image_urls"
    | "terminal_partial_image_urls"
    | "awaiting_image_urls";
  rawStatus: number;
  count: number;
  imageUrls: string[];
};

export const IMAGE_COMPOSITION_HISTORY_RETRY_DELAYS_MS = [1000, 2000, 4000, 5000, 5000] as const;

export function isTransientImageCompositionHistoryError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  return /get history failed/i.test(message);
}

export function getImageCompositionHistoryRetryDelayMs(consecutiveFailureCount: number): number {
  const normalizedCount = Math.max(1, Math.floor(Number(consecutiveFailureCount) || 1));
  const index = Math.min(normalizedCount, IMAGE_COMPOSITION_HISTORY_RETRY_DELAYS_MS.length) - 1;
  return IMAGE_COMPOSITION_HISTORY_RETRY_DELAYS_MS[index];
}

function normalizeImageUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const url = value.trim();
  return /^(?:https?:\/\/|data:image\/)/i.test(url) ? url : "";
}

export function extractImageCompositionUrls(itemList: unknown): string[] {
  const items = Array.isArray(itemList) ? itemList : [];
  const urls: string[] = [];

  const add = (value: unknown) => {
    const url = normalizeImageUrl(value);
    if (url) urls.push(url);
  };

  for (const item of items) {
    const row = item as any;
    const largeImages = Array.isArray(row?.image?.large_images)
      ? row.image.large_images
      : [];
    const beforeLargeImages = urls.length;
    if (largeImages.length > 0) {
      for (const image of largeImages) add(image?.image_url);
      if (urls.length > beforeLargeImages) continue;
    }

    const blendImages = row?.aigc_image_params?.blend_params?.ability_list?.[0]?.large_image_list;
    const beforeBlendImages = urls.length;
    if (Array.isArray(blendImages) && blendImages.length > 0) {
      for (const image of blendImages) add(image?.image_url);
      if (urls.length > beforeBlendImages) continue;
    }

    add(row?.common_attr?.cover_url);
  }

  return [...new Set(urls)];
}

export function classifyImageCompositionSnapshot(
  rawStatusValue: unknown,
  itemList: unknown
): ImageCompositionSnapshot {
  const parsedStatus = Number(rawStatusValue);
  const rawStatus = Number.isFinite(parsedStatus) ? parsedStatus : 0;
  const imageUrls = extractImageCompositionUrls(itemList);

  if (rawStatus === 30) {
    return {
      state: "failed",
      terminal: true,
      reason: "explicit_failure_status_30",
      rawStatus,
      count: imageUrls.length,
      imageUrls,
    };
  }

  if (imageUrls.length >= 4) {
    return {
      state: "success",
      terminal: true,
      reason: "complete_image_urls",
      rawStatus,
      count: imageUrls.length,
      imageUrls,
    };
  }

  if (rawStatus === 10 && imageUrls.length > 0) {
    return {
      state: "success",
      terminal: true,
      reason: "terminal_partial_image_urls",
      rawStatus,
      count: imageUrls.length,
      imageUrls,
    };
  }

  return {
    state: "processing",
    terminal: false,
    reason: "awaiting_image_urls",
    rawStatus,
    count: imageUrls.length,
    imageUrls,
  };
}
