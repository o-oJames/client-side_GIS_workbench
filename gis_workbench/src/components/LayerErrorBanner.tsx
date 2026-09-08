/**
 * LayerErrorBanner — a self-contained error banner displayed when a layer
 * fails to load or render. Extracted from MapPage per AGENTS.md §3.
 */

export interface LayerError {
  id: number;
  title: string;
  detail: string;
}

interface LayerErrorBannerProps {
  error: LayerError;
  onDismiss: () => void;
}

export function LayerErrorBanner({ error, onDismiss }: LayerErrorBannerProps) {
  return (
    <div key={error.id} className="layer-error-banner" role="alert">
      <svg className="layer-error-icon" width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div className="layer-error-body">
        <div className="layer-error-title">{error.title}</div>
        <div className="layer-error-detail">{error.detail}</div>
      </div>
      <button
        type="button"
        className="layer-error-close"
        onClick={onDismiss}
        aria-label="Dismiss error"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
