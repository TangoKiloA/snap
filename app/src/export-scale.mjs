function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function mapCropToNative(crop, dims) {
  const {
    previewWidth,
    previewHeight,
    nativeWidth,
    nativeHeight,
  } = dims;

  if (!crop || !previewWidth || !previewHeight || !nativeWidth || !nativeHeight) {
    return null;
  }

  const sx = nativeWidth / previewWidth;
  const sy = nativeHeight / previewHeight;

  const x = clamp(Math.round(crop.x * sx), 0, nativeWidth);
  const y = clamp(Math.round(crop.y * sy), 0, nativeHeight);
  const w = clamp(Math.round(crop.w * sx), 0, nativeWidth - x);
  const h = clamp(Math.round(crop.h * sy), 0, nativeHeight - y);

  return { x, y, w, h };
}
