// ---------------------------------------------------------------------------
// WandCleanupEditor — clean-up section inside a drawn feature's editor,
// available for magic-wand traced polygons whose as-traced outline is
// stashed in IndexedDB (see utils/snapOriginalStore). The strength slider
// re-simplifies the stashed outline and updates the map live on every tick;
// releasing it records one undo step. The stash lives until the batch is
// saved to a layer (or the feature removed), so the user can drag back and
// forth to tune the vertex count at any time before then.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import {
  CLEANUP_TOLERANCE_MAX_PX,
  CLEANUP_TOLERANCE_MIN_PX,
  DEFAULT_CLEANUP_TOLERANCE_PX,
  countPolygonVertices,
  simplifyPolygonRings,
} from '../utils/polygonClean';
import { loadSnapOriginal, SnapOriginal } from '../utils/snapOriginalStore';

export function WandCleanupEditor({
  featureId,
  workspaceId,
  onLiveUpdate,
  onCommit,
}: {
  featureId: string;
  workspaceId: string;
  /** Replace the polygon's rings live (no history step). */
  onLiveUpdate: (featureId: string, rings: number[][][]) => void;
  /** Record the current shape as one undo step + refresh the panel. */
  onCommit: (featureId: string) => void;
}) {
  const [original, setOriginal] = useState<SnapOriginal | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tolPx, setTolPx] = useState(DEFAULT_CLEANUP_TOLERANCE_PX);

  useEffect(() => {
    let active = true;
    loadSnapOriginal(workspaceId, featureId).then((o) => {
      if (!active) return;
      setOriginal(o);
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [workspaceId, featureId]);

  const simplified = useMemo(
    () => (original ? simplifyPolygonRings(original.rings, tolPx * original.meterPerPx) : null),
    [original, tolPx],
  );

  if (!loaded) {
    return <div className="wand-cleanup-editor-note">Loading traced outline…</div>;
  }
  // No stashed original (not a wand polygon, or the stash was finalised) —
  // nothing to offer.
  if (!original || !simplified) return null;

  const originalCount = countPolygonVertices(original.rings);
  const currentCount = countPolygonVertices(simplified);

  const applyTolerance = (value: number) => {
    setTolPx(value);
    onLiveUpdate(featureId, simplifyPolygonRings(original.rings, value * original.meterPerPx));
  };

  return (
    <div className="wand-cleanup-editor">
      <div className="wand-cleanup-editor-header">
        <span className="wand-cleanup-editor-title">Clean up outline</span>
        <span className="wand-cleanup-editor-counts" title="Vertices as traced vs current">
          {originalCount.toLocaleString()} → {currentCount.toLocaleString()} pts
        </span>
      </div>
      <div className="settings-slider-row">
        <label className="settings-slider-label" htmlFor={`wand-cleanup-${featureId}`}>Strength</label>
        <input
          id={`wand-cleanup-${featureId}`}
          type="range"
          className="settings-slider"
          min={CLEANUP_TOLERANCE_MIN_PX}
          max={CLEANUP_TOLERANCE_MAX_PX}
          step={0.5}
          value={tolPx}
          onChange={(e) => applyTolerance(parseFloat(e.target.value))}
          onPointerUp={() => onCommit(featureId)}
          onKeyUp={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
              onCommit(featureId);
            }
          }}
        />
        <span className="settings-slider-value">{tolPx.toFixed(1)}</span>
      </div>
      <div className="wand-cleanup-editor-actions">
        <button className="wand-cleanup-editor-restore" onClick={() => { applyTolerance(CLEANUP_TOLERANCE_MIN_PX); onCommit(featureId); }}>
          Restore as-traced shape
        </button>
      </div>
    </div>
  );
}
