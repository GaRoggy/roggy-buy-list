export type CameraJson = Record<string, unknown>;

export function hasVerifiedCameraPerson(
  analysis: CameraJson,
  snapshotName: string,
  capturedAt: string,
): boolean {
  if (analysis.person_verified !== true) return false;
  const evidence = analysis.detection_evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
  const item = evidence as CameraJson;
  if (item.verified !== true || item.detector_id !== 'ssd-mobilenetv1-12'
      || item.frame_id !== snapshotName) return false;
  const frameTime = typeof item.frame_timestamp === 'string' ? Date.parse(item.frame_timestamp) : NaN;
  const eventTime = Date.parse(capturedAt);
  if (!Number.isFinite(frameTime) || !Number.isFinite(eventTime)
      || Math.abs(frameTime - eventTime) > 1000) return false;
  const supporting = item.supporting_frames;
  const method = item.verification_method;
  if (typeof supporting !== 'number' || !Number.isInteger(supporting)) return false;
  if (!Array.isArray(item.boxes)) return false;
  return item.boxes.slice(0, 8).some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const boxItem = value as CameraJson;
    if (boxItem.class !== 'person' || typeof boxItem.confidence !== 'number'
        || !Number.isFinite(boxItem.confidence) || boxItem.confidence < 0.35
        || !Array.isArray(boxItem.box) || boxItem.box.length !== 4
        || !boxItem.box.every((coordinate) => typeof coordinate === 'number'
          && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)) return false;
    const [left, top, right, bottom] = boxItem.box as number[];
    if (right <= left || bottom <= top) return false;
    return (method === 'temporal_2_of_3' && supporting >= 2)
      || (method === 'high_confidence_single' && supporting >= 1 && boxItem.confidence >= 0.93);
  });
}
