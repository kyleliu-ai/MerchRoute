// Pure, model-independent policy. The n8n candidate builder embeds this exact
// factory; do not create a second copy of these decisions in workflow Code nodes.
export function createImageCompletionPolicy() {
  const version = 'merchroute-image-v1';
  const targetImageCount = 4;
  const profiles = Object.freeze({
    E001: Object.freeze({ initialMs: 60000, retryMs: 120000, maxPollCount: 0, intervalMs: 10000 }),
    E002: Object.freeze({ initialMs: 0, retryMs: 0, maxPollCount: 120, intervalMs: 10000 }),
    S003: Object.freeze({ initialMs: 300000, retryMs: 300000, maxPollCount: 0, intervalMs: 10000 }),
  });
  function urlKey(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (/^data:image\/(png|jpeg|webp);base64,/i.test(text)) return text;
    // n8n Code sandboxes do not consistently expose the WHATWG URL global.
    if (typeof URL === 'undefined') {
      const match = text.match(/^https?:\/\/([a-z0-9.-]+(?::\d+)?)(\/[^?#\s]*)?(?:\?[^#\s]*)?(?:#[^\s]*)?$/i);
      return match ? match[1].toLowerCase() + (match[2] || '/').split('~')[0] : '';
    }
    try {
      const url = new URL(text);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      // Jimeng CDN variants append ~tplv-* transforms and signed query strings.
      return url.host.toLowerCase() + url.pathname.split('~')[0];
    } catch { return ''; }
  }
  function urls(values, references = []) {
    const excluded = new Set(references.flat(Infinity).map(urlKey).filter(Boolean));
    const seen = new Set();
    return (Array.isArray(values) ? values : []).flat(Infinity).filter(value => {
      const key = urlKey(value);
      if (!key || excluded.has(key) || seen.has(key)) return false;
      seen.add(key); return true;
    }).map(value => value.trim());
  }
  function rejection(input) {
    const code = String(input.failCode || input.code || '');
    const message = String(input.errorMessage || input.message || '');
    return /^(2038|401|403|402|-2000|-2002|-2003|-2004|-2006|-2009|unsupported_.*|invalid_.*|missing_token|insufficient_.*|content_filtered)$/i.test(code)
      || /content.?filter|审核|违禁|unauthorized|forbidden|权限|认证|余额|积分不足|insufficient.?credit/i.test(message);
  }
  function evaluate(input = {}) {
    const rawStatus = Number(input.rawStatus || 0);
    const status = String(input.status || 'processing');
    const all = urls(input.imageUrls || [], input.referenceImages || []);
    const blocked = rejection(input);
    const explicitFailure = status === 'failed' || rawStatus === 30;
    const complete = status === 'success' || rawStatus === 10 || rawStatus === 50;
    const uncertain = status === 'submission_unknown' || status === 'reserved' || input.queryFailed === true;
    const imageUrls = blocked ? [] : all.slice(0, targetImageCount);
    const success = !blocked && imageUrls.length > 0 &&
      (imageUrls.length >= targetImageCount || complete || explicitFailure || input.deadlineReached === true);
    const canRetry = !blocked && !uncertain && explicitFailure && imageUrls.length === 0 && Number(input.retryAttempt || 0) === 0;
    const state = success ? 'success' : blocked || explicitFailure ? 'failed' : 'processing';
    const completionReason = blocked ? 'request_rejected_no_retry'
      : success ? (imageUrls.length >= targetImageCount ? 'target_image_count_reached' : 'partial_image_result')
      : canRetry ? 'explicit_failure_zero_images'
      : explicitFailure ? 'retry_exhausted'
      : input.deadlineReached || uncertain ? 'status_unconfirmed_no_retry' : 'awaiting_image_urls';
    return { policyVersion: version, state, terminal: state !== 'processing', count: imageUrls.length,
      observedCount: all.length, imageUrls, partial: success && imageUrls.length < targetImageCount,
      canRetry, completionReason, rawStatus };
  }
  function timing(profile, attempt, startedAtMs, nowMs, pollCount = 0) {
    const config = profiles[profile];
    if (!config || ![0, 1].includes(attempt)) throw new Error('invalid_image_policy_profile');
    const timeout = attempt ? config.retryMs : config.initialMs;
    const deadlineAtMs = timeout ? startedAtMs + timeout : 0;
    const deadlineReached = deadlineAtMs ? nowMs >= deadlineAtMs : pollCount >= config.maxPollCount;
    return { deadlineAtMs, deadlineReached, maxPollCount: config.maxPollCount,
      waitMs: deadlineReached ? 0 : deadlineAtMs ? Math.min(config.intervalMs, deadlineAtMs - nowMs) : config.intervalMs };
  }
  return Object.freeze({ version, targetImageCount, minimumSuccessImageCount: 1, maxRegenerations: 1, profiles, urlKey, urls, evaluate, timing });
}
export const imageCompletionPolicy = createImageCompletionPolicy();
