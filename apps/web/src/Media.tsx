import { useEffect, useState } from 'react';

type Media = { id: string; name: string; kind: 'image' | 'audio' | 'video'; mimeType: string; sizeBytes: number };
export function MediaManager({ quizId, onPersistedChange }: { quizId: string; onPersistedChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Media[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const base = `/api/quizzes/${quizId}/media`;
  async function request(path: string, init?: RequestInit) {
    const response = await fetch(path, init);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${response.status}).`);
    }
    return response.status === 204 ? undefined : response.json();
  }
  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy(true); setError(''); setStatus('Loading media...');
    void request(base).then(items => { if (active) { setItems(items); setStatus(''); } })
      .catch(cause => { if (active) { setError(cause.message); setStatus(''); } })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [quizId, open]);
  async function upload() {
    if (!file) return;
    setBusy(true); setError(''); setStatus('Uploading...');
    try {
      const data = new FormData(); data.append('file', file);
      const media = await request(base, { method: 'POST', body: data });
      setItems(items => [...items, media]); setStatus(`Uploaded ${media.name}.`);
      onPersistedChange();
    } catch (cause) { setError((cause as Error).message); setStatus('Upload failed.'); }
    finally { setBusy(false); }
  }
  async function remove(media: Media) {
    if (!window.confirm(`Delete “${media.name}”? Questions referencing it will be invalid until fixed. Started games keep their frozen copy.`)) return;
    setBusy(true); setError(''); setStatus('Deleting...');
    try {
      await request(`${base}/${media.id}`, { method: 'DELETE' });
      setItems(items => items.filter(item => item.id !== media.id)); setStatus(`Deleted ${media.name}.`);
      onPersistedChange();
    } catch (cause) { setError((cause as Error).message); setStatus('Delete failed.'); }
    finally { setBusy(false); }
  }
  return <section className="media-manager" aria-label="Quiz media">
    <h2>Media</h2>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide media' : 'Manage media'}</button>
    {open && <>
      <p>Images/GIF up to 20 MB · Audio up to 100 MB · Video up to 500 MB</p>
      <label className="upload-field">Media file<input type="file" accept=".jpg,.jpeg,.png,.webp,.gif,.mp3,.wav,.ogg,.mp4,.webm" disabled={busy}
        onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
      <button type="button" disabled={busy || !file} onClick={() => void upload()}>Upload media</button>
      {status && <p role="status" aria-live="polite">{status}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {!busy && !error && items.length === 0 && <p className="empty-state">No media uploaded.</p>}
      <ul className="quiz-list">{items.map(media => <li key={media.id}>
        <div><strong>{media.name}</strong><p>{media.kind} · {media.mimeType} · {(media.sizeBytes / 1024 / 1024).toFixed(2)} MB</p></div>
        <button type="button" className="subtle danger" disabled={busy} aria-label={`Delete media ${media.name}`} onClick={() => void remove(media)}>Delete</button>
      </li>)}</ul>
    </>}
  </section>;
}
