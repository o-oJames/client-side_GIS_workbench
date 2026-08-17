// ---------------------------------------------------------------------------
// components/PostgisSetupWizard.tsx — Shown when the PostGIS Connector is not
// detected. Provides download links and auto-polls /health until the
// connector starts.
// ---------------------------------------------------------------------------

import { useState, useEffect, useRef } from 'react';
import { findConnector } from '../utils/postgisConnector';
import { CloseIcon } from './Icons';

interface PostgisSetupWizardProps {
  /** Called when the connector is detected (or the user closes the wizard). */
  onDetected: (baseUrl: string) => void;
  onClose: () => void;
}

export function PostgisSetupWizard({ onDetected, onClose }: PostgisSetupWizardProps) {
  const [polling, setPolling] = useState(true);
  const [status, setStatus] = useState<'polling' | 'found'>('polling');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Poll every 2 seconds for the connector
    const poll = async () => {
      const url = await findConnector();
      if (url) {
        setStatus('found');
        setPolling(false);
        if (intervalRef.current) clearInterval(intervalRef.current);
        // Brief delay so user sees the "found" message
        setTimeout(() => onDetected(url), 800);
      }
    };

    // Immediate first check
    poll();
    intervalRef.current = setInterval(poll, 2000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [onDetected]);

  return (
    <div className="postgis-wizard-overlay">
      <div className="postgis-wizard">
        <div className="postgis-wizard-header">
          <h3>PostgreSQL Connector not detected</h3>
          <button className="postgis-wizard-close" onClick={onClose} title="Close" aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="postgis-wizard-body">
          <p>
            To connect to PostgreSQL/PostGIS databases, the <strong>MapViewer PostGIS Connector</strong> must be running on your machine.
          </p>

          <div className="postgis-wizard-section">
            <h4>Quick Start</h4>
            <div className="postgis-wizard-command">
              <code>npm install -g @mapviewer/postgis-connector && mapviewer-connector</code>
            </div>
          </div>

          <div className="postgis-wizard-section">
            <h4>Or download a standalone binary</h4>
            <div className="postgis-wizard-downloads">
              <a href="https://github.com/mapviewer/connector/releases" className="postgis-wizard-download-btn" target="_blank" rel="noopener noreferrer">
                macOS
              </a>
              <a href="https://github.com/mapviewer/connector/releases" className="postgis-wizard-download-btn" target="_blank" rel="noopener noreferrer">
                Windows
              </a>
              <a href="https://github.com/mapviewer/connector/releases" className="postgis-wizard-download-btn" target="_blank" rel="noopener noreferrer">
                Linux
              </a>
            </div>
          </div>

          <div className="postgis-wizard-section">
            <h4>Or use Docker</h4>
            <div className="postgis-wizard-command">
              <code>docker run -p 40000:40000 mapviewer/connector</code>
            </div>
          </div>

          <div className="postgis-wizard-status">
            {status === 'polling' && (
              <span className="postgis-wizard-polling">
                <span className="postgis-wizard-spinner" />
                Waiting for connector…
              </span>
            )}
            {status === 'found' && (
              <span className="postgis-wizard-found">✓ Connector detected!</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
