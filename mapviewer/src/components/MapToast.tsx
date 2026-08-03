/**
 * MapToast — a transient success/error notification overlaid on the map.
 * Extracted from MapPage per AGENTS.md §3.
 */

export interface ToastState {
  id: number;
  message: string;
  kind: 'success' | 'error';
}

interface MapToastProps {
  toast: ToastState;
}

export function MapToast({ toast }: MapToastProps) {
  return (
    <div key={toast.id} className={`map-toast map-toast-${toast.kind}`} role="status">
      {toast.kind === 'success' ? (
        <svg className="map-toast-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg className="map-toast-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      )}
      <span>{toast.message}</span>
    </div>
  );
}
