import { useState, useRef, useEffect } from 'react';
import { WorkspaceMeta } from '../types';
import { WorkspaceIcon, CopyIcon, TrashIcon, PlusIcon, PencilIcon } from './Icons';

/**
 * Workspace switcher in the bottom-left corner of the Settings footer.
 * Every workspace keeps its own layers, groups, basemap and toggles; picking
 * one reloads the map with that workspace's saved setup.
 */
export function WorkspaceSelector({
  workspaceId,
  workspaces,
  onSwitch,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
}: {
  workspaceId: string;
  workspaces: WorkspaceMeta[];
  onSwitch: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newValue, setNewValue] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  const active = workspaces.find(w => w.id === workspaceId);
  const canDelete = workspaces.length > 1;

  // Close the popover on any pointer-down outside of it.
  useEffect(() => {
    if (!open) return;
    const handleDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setRenamingId(null);
        setConfirmDeleteId(null);
        setCreating(false);
        setNewValue('');
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [open]);

  // Escape closes the popover (or cancels an inline edit first).
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (renamingId) { setRenamingId(null); return; }
      if (creating) { setCreating(false); setNewValue(''); return; }
      if (confirmDeleteId) { setConfirmDeleteId(null); return; }
      setOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, renamingId, creating, confirmDeleteId]);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (creating && newInputRef.current) newInputRef.current.focus();
  }, [creating]);

  const commitRename = () => {
    if (renamingId) {
      const name = renameValue.trim();
      if (name) onRename(renamingId, name);
    }
    setRenamingId(null);
  };

  const commitCreate = () => {
    const name = newValue.trim();
    setCreating(false);
    setNewValue('');
    if (name) {
      setOpen(false); // the switch remounts the page anyway; close for neatness
      onCreate(name);
    }
  };

  return (
    <div className="workspace-selector" ref={rootRef}>
      <button
        type="button"
        className={`workspace-selector-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Switch workspace — each workspace keeps its own layers and settings"
        aria-label={`Switch workspace — current: ${active ? active.name : 'none'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <WorkspaceIcon />
        <span className="workspace-selector-name">{active ? active.name : 'Workspace'}</span>
        <svg className="workspace-selector-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m18 15-6-6-6 6" />
        </svg>
      </button>
      {open && (
        <div className="workspace-menu" role="listbox" aria-label="Workspaces">
          <div className="workspace-menu-heading">Workspaces</div>
          <div className="workspace-menu-list">
            {workspaces.map(ws => (
              <div
                key={ws.id}
                className={`workspace-row${ws.id === workspaceId ? ' active' : ''}`}
                role="option"
                aria-selected={ws.id === workspaceId}
              >
                {renamingId === ws.id ? (
                  <input
                    ref={renameInputRef}
                    className="workspace-rename-input"
                    value={renameValue}
                    maxLength={40}
                    onChange={e => setRenameValue(e.target.value)}
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename();
                      else if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <button
                    type="button"
                    className="workspace-row-name"
                    aria-label={ws.id === workspaceId ? `${ws.name} (current workspace)` : `Switch to ${ws.name}`}
                    title={ws.id === workspaceId ? 'Current workspace' : `Switch to \u201c${ws.name}\u201d`}
                    onClick={() => {
                      if (ws.id !== workspaceId) {
                        setOpen(false);
                        onSwitch(ws.id);
                      }
                    }}
                  >
                    {ws.name}
                  </button>
                )}
                <span className="workspace-row-actions">
                  {ws.id === workspaceId && (
                    <svg className="workspace-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                  {confirmDeleteId === ws.id ? (
                    <button
                      type="button"
                      className="workspace-action workspace-delete-confirm"
                      title="Confirm delete"
                      onMouseDown={e => e.preventDefault()}
                      onClick={e => {
                        e.stopPropagation();
                        setConfirmDeleteId(null);
                        onDelete(ws.id);
                      }}
                    >
                      Sure?
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="workspace-action"
                        title="Rename workspace"
                        onMouseDown={e => e.preventDefault()}
                        onClick={e => {
                          e.stopPropagation();
                          setConfirmDeleteId(null);
                          setRenamingId(ws.id);
                          setRenameValue(ws.name);
                        }}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className="workspace-action"
                        title="Duplicate workspace"
                        onMouseDown={e => e.preventDefault()}
                        onClick={e => {
                          e.stopPropagation();
                          setConfirmDeleteId(null);
                          onDuplicate(ws.id);
                        }}
                      >
                        <CopyIcon />
                      </button>
                      <button
                        type="button"
                        className="workspace-action workspace-delete"
                        title={canDelete ? 'Delete workspace' : 'The last workspace cannot be deleted'}
                        disabled={!canDelete}
                        onMouseDown={e => e.preventDefault()}
                        onClick={e => {
                          e.stopPropagation();
                          if (canDelete) setConfirmDeleteId(ws.id);
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
          <div className="workspace-menu-footer">
            {creating ? (
              <div className="workspace-create-row">
                <input
                  ref={newInputRef}
                  className="workspace-rename-input"
                  placeholder="Workspace name"
                  value={newValue}
                  maxLength={40}
                  onChange={e => setNewValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitCreate();
                    else if (e.key === 'Escape') { setCreating(false); setNewValue(''); }
                  }}
                  onBlur={commitCreate}
                />
                <button
                  type="button"
                  className="workspace-apply-button"
                  disabled={!newValue.trim()}
                  title="Create workspace"
                  // Keep focus on the input so its blur handler does not
                  // double-commit before this click lands.
                  onMouseDown={e => e.preventDefault()}
                  onClick={commitCreate}
                >
                  Apply
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="workspace-new-button"
                onClick={() => {
                  setRenamingId(null);
                  setConfirmDeleteId(null);
                  setCreating(true);
                }}
              >
                <PlusIcon /> New workspace
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
