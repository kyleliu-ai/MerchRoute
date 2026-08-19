const REDACTED = "<redacted>";

function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveLogKey(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  return normalized === "auth" ||
    normalized === "password" ||
    normalized === "spacename" ||
    normalized.includes("accesskeyid") ||
    normalized.includes("secretaccesskey") ||
    normalized.includes("sessiontoken") ||
    normalized.includes("refreshtoken") ||
    normalized.includes("authorization") ||
    normalized.includes("apikey") ||
    normalized.includes("signature") ||
    normalized === "imageuri" ||
    normalized === "imageurilist" ||
    normalized === "uploadedimageid" ||
    normalized === "uploadedimageids" ||
    normalized === "uri" ||
    normalized.includes("xbogus") ||
    normalized.includes("xgnarly") ||
    normalized.includes("cookie") ||
    normalized === "token" ||
    normalized.endsWith("token");
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(
      /([?&](?:access_key_id|secret_access_key|session_token|refresh_token|token|signature|x-amz-security-token|x-amz-signature|x-bogus|x-gnarly)=)[^&#\s"']+/gi,
      `$1${REDACTED}`
    )
    .replace(
      /((?:access_key_id|secret_access_key|session_token|refresh_token|authorization|api[_-]?key|signature|x-bogus|x-gnarly|cookie|space[_-]?name)\s*[=:]\s*)[^,;&\s}"']+/gi,
      `$1${REDACTED}`
    )
    // Jimeng/ImageX references are reusable upload identifiers. They are not
    // credentials, but logging the full value leaks source-image capability.
    .replace(/\btos-[a-z0-9-]+\/[A-Za-z0-9._~%+/=:@-]+/gi, REDACTED);
}

function tryParseJsonString(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
      !(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > 12) return "<max-depth>";
  if (typeof value === "string") {
    const parsed = tryParseJsonString(value);
    if (parsed !== undefined) {
      return JSON.stringify(redactValue(parsed, seen, depth + 1));
    }
    return redactSensitiveText(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "<circular>";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactValue(entry, seen, depth + 1));
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitiveLogKey(key) ? REDACTED : redactValue(entry, seen, depth + 1);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function redactSensitiveLogValue(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>(), 0);
}

export function summarizeSensitiveResponseForLog(value: unknown, maxLength = 500): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(redactSensitiveLogValue(value));
  } catch {
    serialized = JSON.stringify("<unserializable-response>");
  }
  const limit = Math.max(1, Math.floor(Number(maxLength) || 500));
  return serialized.length > limit ? `${serialized.substring(0, limit)}...` : serialized;
}
