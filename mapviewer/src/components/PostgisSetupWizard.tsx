// ---------------------------------------------------------------------------
// components/PostgisSetupWizard.tsx — Shown when the Workbench Companion is not
// detected. Provides download links and auto-polls /health until the
// companion starts.
// ---------------------------------------------------------------------------

import { useState, useEffect, useRef } from 'react';
import { findConnector } from '../utils/companion';
import { CloseIcon } from './Icons';

interface PostgisSetupWizardProps {
  /** Called when the companion is detected (or the user closes the wizard). */
  onDetected: (baseUrl: string) => void;
  onClose: () => void;
}

export function PostgisSetupWizard({ onDetected, onClose }: PostgisSetupWizardProps) {
  const [polling, setPolling] = useState(true);
  const [status, setStatus] = useState<'polling' | 'found'>('polling');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Poll every 2 seconds for the companion
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
          <h3>Workbench Companion not detected</h3>
          <button className="postgis-wizard-close" onClick={onClose} title="Close" aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="postgis-wizard-body">
          <p>
            To use PostgreSQL/PostGIS databases and S3 Cloud Optimized GeoTIFFs, the <strong>MapViewer Workbench Companion</strong> must be running on your machine.
          </p>

          <div className="postgis-wizard-section">
            <h4>What does the companion do?</h4>
            <ul className="postgis-wizard-features">
              <li>Connect to PostgreSQL/PostGIS databases and load tables as vector layers</li>
              <li>Proxy S3 Cloud Optimized GeoTIFF (COG) requests, bypassing CORS restrictions</li>
              <li>Auto-detect S3 bucket regions and pre-sign URLs server-side</li>
            </ul>
          </div>

          <div className="postgis-wizard-section">
            <h4>Quick Start</h4>
            <div className="postgis-wizard-command">
              <code>npm install -g @mapviewer/workbench-companion && workbench-companion</code>
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
              <code>docker run -p 40000:40000 mapviewer/workbench-companion</code>
            </div>
          </div>

          <div className="postgis-wizard-status">
            {status === 'polling' && (
              <span className="postgis-wizard-polling">
                <span className="postgis-wizard-spinner" />
                Waiting for companion…
              </span>
            )}
            {status === 'found' && (
              <span className="postgis-wizard-found">✓ Companion detected!</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
