/**
 * LoadingIndicator — a small spinner + message row shown while an async
 * operation (layer restore, add, capabilities fetch) is in flight.
 * Extracted per AGENTS.md §3 to deduplicate repeated loading markup.
 */

interface LoadingIndicatorProps {
  message: string;
}

export function LoadingIndicator({ message }: LoadingIndicatorProps) {
  return (
    <div className="settings-loading-indicator">
      <div className="settings-loading-spinner"></div>
      <span>{message}</span>
    </div>
  );
}
