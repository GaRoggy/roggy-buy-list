(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FrontDoorEvidence = api;
})(globalThis, function () {
  function hasVerifiedPerson(analysis, snapshotName, capturedAt) {
    if (!analysis || analysis.person_verified !== true) return false;
    const evidence = analysis.detection_evidence;
    if (!evidence || typeof evidence !== "object" || evidence.verified !== true
        || evidence.detector_id !== "ssd-mobilenetv1-12" || evidence.frame_id !== snapshotName) return false;
    const frameTime = Date.parse(evidence.frame_timestamp || ""), eventTime = Date.parse(capturedAt || "");
    if (!Number.isFinite(frameTime) || !Number.isFinite(eventTime) || Math.abs(frameTime - eventTime) > 1000) return false;
    const supporting = Number(evidence.supporting_frames), method = evidence.verification_method;
    if (!Number.isInteger(supporting) || !Array.isArray(evidence.boxes)) return false;
    return evidence.boxes.slice(0, 8).some(item => {
      if (!item || item.class !== "person" || !Number.isFinite(item.confidence) || item.confidence < 0.35) return false;
      if (!Array.isArray(item.box) || item.box.length !== 4 || !item.box.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return false;
      const [left, top, right, bottom] = item.box;
      if (right <= left || bottom <= top) return false;
      return (method === "temporal_2_of_3" && supporting >= 2)
        || (method === "high_confidence_single" && supporting >= 1 && item.confidence >= 0.93);
    });
  }

  function shouldIncludeLocalEvent(eventType, data, snapshotName, capturedAt) {
    return eventType === "camera.person_event"
      && hasVerifiedPerson(data, snapshotName, capturedAt);
  }

  return { hasVerifiedPerson, shouldIncludeLocalEvent };
});
