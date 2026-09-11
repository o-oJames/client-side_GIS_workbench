// ---------------------------------------------------------------------------
// PostgisConnector.test.tsx — Integration test: setup wizard shows when the
// Workbench Companion is down, hides when detected. (The companion was renamed
// from "PostGIS Connector"; the user-facing strings say "companion".)
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import { PostgisSetupWizard } from './components/PostgisSetupWizard';

// Mock the companion module
vi.mock('./utils/companion', () => ({
  findConnector: vi.fn(),
}));

import { findConnector } from './utils/companion';

const mockFindConnector = findConnector as MockedFunction<typeof findConnector>;

beforeEach(() => {
  mockFindConnector.mockReset();
});

describe('PostgisSetupWizard', () => {
  it('shows polling status while the companion is not detected', () => {
    mockFindConnector.mockReturnValue(Promise.resolve(null));

    render(<PostgisSetupWizard onDetected={() => {}} onClose={() => {}} />);

    expect(screen.getByText(/Waiting for companion/i)).toBeInTheDocument();
  });

  it('shows download links', () => {
    mockFindConnector.mockReturnValue(Promise.resolve(null));

    render(<PostgisSetupWizard onDetected={() => {}} onClose={() => {}} />);

    expect(screen.getByText('macOS')).toBeInTheDocument();
    expect(screen.getByText('Windows')).toBeInTheDocument();
    expect(screen.getByText('Linux')).toBeInTheDocument();
  });

  it('shows npm install command', () => {
    mockFindConnector.mockReturnValue(Promise.resolve(null));

    render(<PostgisSetupWizard onDetected={() => {}} onClose={() => {}} />);

    expect(screen.getByText(/npm install/i)).toBeInTheDocument();
  });

  it('shows Docker command', () => {
    mockFindConnector.mockReturnValue(Promise.resolve(null));

    render(<PostgisSetupWizard onDetected={() => {}} onClose={() => {}} />);

    expect(screen.getByText(/docker run/i)).toBeInTheDocument();
  });

  it('calls onDetected when the companion is found', async () => {
    mockFindConnector.mockResolvedValue('http://localhost:40000');
    const onDetected = vi.fn();

    render(<PostgisSetupWizard onDetected={onDetected} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Companion detected/i)).toBeInTheDocument();
    });

    // onDetected is called after a brief delay
    await waitFor(() => {
      expect(onDetected).toHaveBeenCalledWith('http://localhost:40000');
    }, { timeout: 2000 });
  });

  it('calls onClose when close button is clicked', () => {
    mockFindConnector.mockReturnValue(Promise.resolve(null));
    const onClose = vi.fn();

    render(<PostgisSetupWizard onDetected={() => {}} onClose={onClose} />);

    const closeBtn = screen.getByLabelText('Close');
    closeBtn.click();
    expect(onClose).toHaveBeenCalled();
  });
});
