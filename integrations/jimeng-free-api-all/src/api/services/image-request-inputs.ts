// Request normalizes koa-body's keyed uploads into filesMap and a flat files
// array. Keep the field name contract: an unrelated upload is not an image.
export function multipartImageFiles(request: {
  filesMap?: Record<string, unknown>; rawFiles?: Record<string, unknown>; files?: unknown;
}): unknown {
  return request.filesMap?.images ?? request.rawFiles?.images ?? (request.files as any)?.images;
}
