// Opening a file, as opposed to downloading it.
//
// Pictures, video, sound, PDFs, text, office documents and ZIP listings. Everything else says what it is and
// offers the download, because a broken box where a file should be is worse than
// an honest sentence.
//
// The rule that decides what is safe here has not moved: customer content is
// never interpreted as HTML on the signed-in origin. Bytes are fetched with the
// token, held as a blob, and handed to an element that displays that kind of
// thing — <img>, <video>, <audio>, or a frame for a PDF. Every one of those
// blobs is built with a type this file chose from the extension and the declared
// mime, never with a type the file asserted about itself, and a browser does not
// sniff a blob URL: a frame told it holds a PDF renders a PDF or renders
// nothing. Nothing here ever produces text/html, and the one thing that would
// make any of this dangerous — script-src — was not widened to allow it.

import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Button, FileName, Icon, Note, bytes } from './ui.jsx';

// What the browser can show, decided from the extension first and the declared
// mime second. The mime came from whatever uploaded the file and is a claim; the
// extension is at least the owner's own word for what they think it is.
const KINDS = [
  { kind: 'docx', ext: /\.docx$/i, mime: /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/ },
  { kind: 'xlsx', ext: /\.xlsx$/i, mime: /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/ },
  { kind: 'zip', ext: /\.zip$/i, mime: /^application\/(zip|x-zip-compressed)$/ },
  { kind: 'image', ext: /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i, mime: /^image\//, type: extType },
  { kind: 'video', ext: /\.(mp4|webm|ogv|mov|m4v)$/i, mime: /^video\//, type: extType },
  { kind: 'audio', ext: /\.(mp3|wav|ogg|oga|m4a|aac|flac)$/i, mime: /^audio\//, type: extType },
  { kind: 'pdf', ext: /\.pdf$/i, mime: /^application\/pdf$/, type: () => 'application/pdf' },
  {
    kind: 'text',
    ext: /\.(txt|md|markdown|log|csv|tsv|json|ya?ml|toml|ini|conf|env|sql|sh|bash|zsh|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|xml|svg|py|rb|go|rs|java|kt|c|h|cpp|php|pl|lua|swift|r|tex|gitignore|dockerfile|makefile)$/i,
    mime: /^(text\/|application\/(json|xml|javascript|x-sh|x-yaml|toml))/,
    type: () => 'text/plain',
  },
];

// An .html file is read, never rendered. That is the whole difference between a
// preview and handing somebody else's markup the run of this origin.
const MONOSPACE = /\.(md|markdown|json|ya?ml|toml|ini|conf|env|sql|sh|bash|zsh|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|xml|svg|py|rb|go|rs|java|kt|c|h|cpp|php|pl|lua|swift|r|tex|log|csv|tsv)$/i;

// Past these there is nothing to gain: the file is pulled through memory to show
// something nobody can read anyway. Video and sound stream, so they are not
// capped the same way — but they are still fetched whole, because the bytes need
// the token and a range request cannot carry one.
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_OFFICE = 20 * 1024 * 1024;
const OFFICE = new Set(['docx', 'xlsx', 'zip']);
const MAX_INLINE = 120 * 1024 * 1024;

function extType(file) {
  const declared = String(file.mime || '');
  if (/^(image|video|audio)\//.test(declared)) return declared;
  const guess = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', m4v: 'video/mp4',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4',
    aac: 'audio/aac', flac: 'audio/flac',
  }[String(file.name || '').split('.').pop().toLowerCase()];
  return guess || 'application/octet-stream';
}

export function kindOf(file) {
  const name = String(file.name || '');
  const mime = String(file.mime || '');
  const match = KINDS.find(candidate => candidate.ext.test(name) || candidate.mime.test(mime));
  return match ? match.kind : 'other';
}

export function Preview({ file, onDownload }) {
  const [state, setState] = useState({ kind: 'loading' });

  useEffect(() => {
    setState({ kind: 'loading' });
    let alive = true;
    let made = null;
    (async () => {
      const wanted = KINDS.find(candidate => candidate.ext.test(String(file.name || '')) || candidate.mime.test(String(file.mime || '')));
      if (!wanted) { setState({ kind: 'other' }); return; }
      const cap = wanted.kind === 'text' ? MAX_TEXT : OFFICE.has(wanted.kind) ? MAX_OFFICE : MAX_INLINE;
      if ((file.size || 0) > cap) { setState({ kind: 'other', tooBig: true }); return; }
      try {
        const response = await api.download(file.id);
        if (!response.ok) {
          // A refusal is not a format this browser cannot draw, and saying so
          // was a lie with a dead button under it: the fallback offered
          // "Download it", which is the very thing that had just been refused.
          // The box already sends the reason in the body, so it is shown rather
          // than guessed at.
          const why = response.status === 403
            ? ((await response.json().catch(() => null)) || {}).error || null
            : null;
          if (alive) setState(why ? { kind: 'refused', why } : { kind: 'other' });
          return;
        }
        if (wanted.kind === 'text') {
          const text = await response.text();
          if (alive) setState({ kind: 'text', text, mono: MONOSPACE.test(String(file.name || '')) });
          return;
        }
        if (OFFICE.has(wanted.kind)) {
          const buffer = await response.arrayBuffer();
          const { decodeOffice } = await import('./preview-office.js');
          const decoded = await decodeOffice(wanted.kind, buffer);
          if (alive) setState(decoded);
          return;
        }
        // The type is this code's decision, not the file's claim about itself.
        const blob = new Blob([await response.arrayBuffer()], { type: wanted.type(file) });
        made = URL.createObjectURL(blob);
        if (alive) setState({ kind: wanted.kind, url: made });
        else URL.revokeObjectURL(made);
      } catch {
        if (alive) setState({ kind: 'other' });
      }
    })();
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [file.id, file.mime, file.name, file.size]);

  if (state.kind === 'loading') {
    return <div className="preview preview--middle"><span className="spinner" /><span>Opening securely…</span></div>;
  }

  if (state.kind === 'image') {
    return (
      <div className="preview preview--image">
        <img src={state.url} alt={file.name} />
        <div className="preview__caption"><FileName name={file.name} /><span>{bytes(file.size)}</span></div>
      </div>
    );
  }

  if (state.kind === 'video') {
    return (
      <div className="preview preview--media">
        <video src={state.url} controls playsInline preload="metadata" aria-label={file.name} />
        <div className="preview__caption"><FileName name={file.name} /><span>{bytes(file.size)}</span></div>
      </div>
    );
  }

  if (state.kind === 'audio') {
    return (
      <div className="preview preview--middle">
        <div className="preview-sound">
          <span className="preview-fallback__icon"><Icon name="file" size={30} /></span>
          <FileName name={file.name} />
          <audio src={state.url} controls preload="metadata" aria-label={file.name} />
          <span className="preview-sound__size">{bytes(file.size)}</span>
        </div>
      </div>
    );
  }

  if (state.kind === 'pdf') {
    // The frame is the browser's own viewer, and not every browser has one:
    // some download PDFs instead of showing them, which inside a frame means an
    // empty rectangle. So the way to keep the file sits under it always, and a
    // browser that cannot render this is a caption away from being useful
    // rather than a blank box.
    return (
      <div className="preview preview--document">
        <iframe
          className="preview__frame"
          src={state.url}
          title={file.name}
          // allow-scripts and nothing else, which is the pair that matters. A
        // sandboxed frame without allow-same-origin gets an opaque origin of its
        // own, so what runs inside cannot read this page, its storage or its
        // token — and the browser's own PDF viewer is a script, so an empty
        // sandbox renders nothing at all. Granting allow-scripts together with
        // allow-same-origin is the combination that undoes the sandbox; that is
        // why only one of the two is here.
          sandbox="allow-scripts"
        />
        <div className="preview__caption">
          <FileName name={file.name} />
          <span>{bytes(file.size)}</span>
          <Button icon="download" onClick={onDownload}>Download it</Button>
        </div>
      </div>
    );
  }

  if (state.kind === 'text') {
    return <pre className={`preview preview--text${state.mono ? ' preview--code' : ''}`}>{state.text.slice(0, MAX_TEXT)}</pre>;
  }

  if (state.kind === 'docx') {
    return <article className="preview preview--office" aria-label={file.name}>
      {state.paragraphs.length ? state.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>) : <p>This document has no text.</p>}
    </article>;
  }

  if (state.kind === 'xlsx') {
    return <div className="preview preview--office">
      <h2>{state.sheet} — first sheet</h2>
      {state.truncated && <Note>Showing the first 1,000 rows and up to 100 columns. Download the file to read the rest.</Note>}
      {state.rows.length ? <table className="preview__table" aria-label={`${file.name}, first sheet`}>
        <tbody>{state.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
      </table> : <p>This sheet is empty.</p>}
    </div>;
  }

  if (state.kind === 'zip') {
    return <div className="preview preview--office">
      <h2>{state.entries.length} {state.entries.length === 1 ? 'entry' : 'entries'}</h2>
      <table className="preview__table" aria-label={`${file.name}, contents`}>
        <thead><tr><th scope="col">Name</th><th scope="col">Size</th></tr></thead>
        <tbody>{state.entries.map((entry, index) => <tr key={index}>
          <td>{entry.name}</td><td>{entry.directory ? 'Folder' : `${entry.size.toLocaleString()} bytes`}</td>
        </tr>)}</tbody>
      </table>
    </div>;
  }

  // Refused rather than undrawable. No download button: offering the one thing
  // that was just refused is how a boundary reads as a bug.
  if (state.kind === 'refused') {
    return (
      <div className="preview preview--middle">
        <div className="preview-fallback">
          <span className="preview-fallback__icon"><Icon name="lock" size={30} /></span>
          <FileName name={file.name} />
          <Note tone="quiet">{state.why}</Note>
        </div>
      </div>
    );
  }

  return (
    <div className="preview preview--middle">
      <div className="preview-fallback">
        <span className="preview-fallback__icon"><Icon name="file" size={30} /></span>
        <FileName name={file.name} />
        <Note>
          {state.tooBig
            ? `This is ${bytes(file.size)}, which is more than is worth pulling through a browser to look at. Here it is to keep.`
            : `This is a ${file.mime || 'file'} of ${bytes(file.size)}. It is not something a browser can show, so here it is to keep.`}
        </Note>
        <Button kind="solid" icon="download" onClick={onDownload}>Download it</Button>
      </div>
    </div>
  );
}
