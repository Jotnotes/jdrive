// A share recipient never enters the signed-in shell. The token stays in the
// path, an optional password is sent only as a header, and file bytes are shown
// only as a blob-backed image or text inside a <pre>.

import { useCallback, useEffect, useState } from 'react';
import { brand, named } from './brand.js';
import { BrandMark, Button, Field, FileName, Icon, Note, PLACES, bytes } from './ui.jsx';

const READABLE = /^(text\/|application\/(json|xml|javascript|x-sh))/;
const MAX_TEXT_BYTES = 400000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// This is the surface that leaves the building. A recipient has no account, may
// never have heard of the person who sent the file, and is looking at a page to
// decide whether to trust it — so it carries the sender's supplier's name, or a
// plain true description of itself, and never a product name of ours.
const recipientBrand = () => named('Secure files');

function fileName(response) {
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const simple = disposition.match(/filename="([^"]+)"/i)?.[1];
  try { return decodeURIComponent(encoded || simple || 'Shared file'); }
  catch { return simple || 'Shared file'; }
}

export function SharedFileScreen({ token }) {
  const [password, setPassword] = useState('');
  const [givenPassword, setGivenPassword] = useState('');
  const [status, setStatus] = useState('loading');
  const [asset, setAsset] = useState(null);
  const [error, setError] = useState(null);

  const open = useCallback(async given => {
    setStatus('loading');
    setError(null);
    try {
      const headers = given ? { 'X-Share-Password': given } : {};
      const metadata = await fetch(`/s/${token}`, { method: 'HEAD', headers, cache: 'no-store' });
      if (metadata.status === 401) { setStatus('locked'); return; }
      if (!metadata.ok) { setStatus('unavailable'); return; }

      const mime = metadata.headers.get('content-type') || 'application/octet-stream';
      const length = metadata.headers.get('content-length');
      const size = length && /^\d+$/.test(length) ? Number(length) : null;
      const name = fileName(metadata);
      const isImage = mime.startsWith('image/');
      const isText = READABLE.test(mime);
      const canRender = size !== null && ((isImage && size <= MAX_IMAGE_BYTES) || (isText && size <= MAX_TEXT_BYTES));
      const permission = await fetch(`/s/${token}/download`, { method: 'HEAD', headers, cache: 'no-store' });
      let next = {
        kind: 'other', name, mime, size, canDownload: permission.ok,
        tooLarge: size !== null && (isImage || isText) && !canRender,
      };

      if (canRender) {
        const content = await fetch(`/s/${token}`, { headers, cache: 'no-store' });
        if (!content.ok) { setStatus('unavailable'); return; }
        const blob = await content.blob();
        if (isImage) next = { ...next, kind: 'image', url: URL.createObjectURL(blob) };
        else next = { ...next, kind: 'text', text: await blob.text() };
      }

      setGivenPassword(given);
      setAsset(next);
      setStatus('open');
    } catch {
      setStatus('error');
    }
  }, [token]);

  useEffect(() => { open(''); }, [open]);
  useEffect(() => () => { if (asset?.url) URL.revokeObjectURL(asset.url); }, [asset?.url]);

  const download = async () => {
    setError(null);
    try {
      const headers = givenPassword ? { 'X-Share-Password': givenPassword } : {};
      const response = await fetch(`/s/${token}/download`, { headers, cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 403 ? 'The owner shared this for viewing only.' : 'This file could not be downloaded.');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = asset.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) { setError(err.message); }
  };

  return (
    <main className="recipient-screen">
      <section className="recipient-card" aria-live="polite">
        <header className="recipient-card__header">
          <div className="recipient-card__brand"><BrandMark size={27} /><span>{recipientBrand()}</span></div>
          <span className="recipient-card__reach"><Icon name="shared" size={14} />Shared with you</span>
        </header>

        {status === 'loading' && <div className="recipient-state"><span className="spinner" /><p>Opening this private link…</p></div>}

        {status === 'locked' && (
          <form className="recipient-form" onSubmit={event => { event.preventDefault(); open(password); }}>
            <span className="recipient-form__icon"><Icon name="lock" size={25} /></span>
            <div><h1>This link has a password</h1><p>Ask the sender for it in the message where they shared this file.</p></div>
            <Field label="Share password" type="password" value={password} autoFocus autoComplete="current-password" onChange={event => setPassword(event.target.value)} />
            <Button kind="solid" tone={PLACES.shared.tone} disabled={password.length < 6}>Open the file</Button>
          </form>
        )}

        {(status === 'unavailable' || status === 'error') && (
          <div className="recipient-state recipient-state--message">
            <span className="recipient-form__icon"><Icon name={status === 'error' ? 'warning' : 'clock'} size={25} /></span>
            <h1>{status === 'error' ? 'The box could not be reached' : 'This link is no longer available'}</h1>
            <p>{status === 'error' ? 'Check your connection and try the address again.' : 'It may have expired or been stopped by its owner.'}</p>
          </div>
        )}

        {status === 'open' && asset && (
          <div className="recipient-file">
            <div className="recipient-file__title">
              <span className="recipient-form__icon"><Icon name="file" size={23} /></span>
              <div><FileName name={asset.name} /><small>{asset.mime}{asset.size === null ? ' · size unavailable' : ` · ${bytes(asset.size)}`}</small></div>
              {asset.canDownload && <Button icon="download" onClick={download}>Save a copy</Button>}
            </div>
            {error && <Note tone="bad">{error}</Note>}
            <div className="recipient-preview">
              {asset.kind === 'image' && <img src={asset.url} alt={asset.name} />}
              {asset.kind === 'text' && <pre>{asset.text}</pre>}
              {asset.kind === 'other' && (
                <div className="preview-fallback">
                  <span className="preview-fallback__icon"><Icon name="file" size={30} /></span>
                  <p>{asset.tooLarge
                    ? 'This file is too large to preview safely here.'
                    : asset.canDownload ? 'This file type cannot be previewed safely here.' : 'This view-only file type cannot be previewed safely here.'}</p>
                  {asset.canDownload && <Button kind="solid" tone={PLACES.shared.tone} icon="download" onClick={download}>Download it</Button>}
                </div>
              )}
            </div>
          </div>
        )}

        <footer className="recipient-card__footer">
          <Icon name="lock" size={13} />No account or sign-in is needed. This link can expire.
          {brand.support ? <> · <a href={brand.support} rel="noreferrer nofollow">Get help</a></> : null}
        </footer>
      </section>
    </main>
  );
}
