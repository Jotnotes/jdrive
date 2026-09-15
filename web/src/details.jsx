// What a file is, what it says about itself, and what its owner calls it.
//
// Two different kinds of fact sit here on purpose. The camera's are read out of
// the file's own bytes and cannot be edited — they are what happened. The tags
// are the owner's own words and are nothing but editable. Neither is AI, and
// neither changes who can reach the file: a tag is a label, not a place.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Sheet } from './share.jsx';
import { Button, Icon, Note, PLACES, bytes, moment, when } from './ui.jsx';

export function DetailsSheet({ file, folderName, onClose, onChanged }) {
  const [exif, setExif] = useState(undefined);
  const [xmp, setXmp] = useState(undefined);
  const [history, setHistory] = useState(null);
  const [tags, setTags] = useState(file.tags || []);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const field = useRef(null);
  const place = PLACES[file.place] || PLACES.private;

  const readHistory = useCallback(() => api.versions(file.id)
    .then(out => setHistory(out))
    .catch(() => setHistory({ versions: [] })), [file.id]);

  useEffect(() => {
    let alive = true;
    api.metadata(file.id)
      .then(out => { if (alive) { setExif(out.exif); setXmp(out.xmp); setTags(out.file.tags || []); } })
      .catch(() => { if (alive) { setExif(null); setXmp(null); } });
    readHistory();
    return () => { alive = false; };
  }, [file.id, file.versions, readHistory]);

  const goBack = async version => {
    setBusy(true);
    setError(null);
    try {
      await api.restoreVersion(file.id, version.id);
      await readHistory();
      const metadata = await api.metadata(file.id);
      setExif(metadata.exif);
      setXmp(metadata.xmp);
      onChanged && onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const look = async version => {
    try {
      const response = await api.downloadVersion(file.id, version.id);
      if (!response.ok) throw new Error('That version could not be opened.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = version.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { setError(e.message); }
  };

  const add = async event => {
    event.preventDefault();
    const name = typed.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.tagFile(file.id, name);
      setTags(out.file.tags || []);
      setTyped('');
      onChanged && onChanged();
      field.current && field.current.focus();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const remove = async tag => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.untagFile(file.id, tag.id);
      setTags(out.file.tags || []);
      onChanged && onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Sheet title="Details" eyebrow={file.name} tone={place.tone} onClose={onClose}>
      <FactList rows={[
        ['Kind', file.mime || 'unknown'],
        ['Size', bytes(file.size)],
        ['Added', when(file.added_at)],
        ['Reach', `${place.label} — ${place.hint.toLowerCase()}`],
        file.place === 'private' && folderName ? ['Folder', folderName] : null,
        file.place === 'trash' && file.deleted_at ? ['Deleted', when(file.deleted_at)] : null,
      ]} />

      <section className="details-section">
        <h3 className="details-section__title">
          <Icon name="info" size={14} />What the camera recorded
        </h3>
        {exif === undefined && <p className="details-empty">Reading the file…</p>}
        {exif === null && (
          <p className="details-empty">
            This file carries no camera information. Photographs usually do; things a computer made usually do not.
          </p>
        )}
        {exif && (
          <>
            <FactList rows={[
              ['Camera', [exif.camera_make, exif.camera_model].filter(Boolean).join(' ') || null],
              ['Lens', exif.lens],
              // Shown exactly as the camera wrote it. It named no timezone, so
              // neither does this: converting it would move the hour.
              ['Taken', exif.taken_at ? `${exif.taken_at} (as the camera recorded it)` : null],
              ['Size', exif.width && exif.height ? `${exif.width} × ${exif.height}` : null],
              ['Settings', exposure(exif)],
              ['Software', exif.software],
            ]} />
            {Number.isFinite(exif.gps_lat) && Number.isFinite(exif.gps_lon) && (
              <Note tone="quiet">
                <strong>This file carries a location.</strong>{' '}
                {exif.gps_lat.toFixed(5)}, {exif.gps_lon.toFixed(5)}
                {Number.isFinite(exif.gps_altitude_m) ? `, ${Math.round(exif.gps_altitude_m)}m` : ''}.
                It is inside the file, so it travels with any copy of it — including a published one.
              </Note>
            )}
          </>
        )}
      </section>

      {xmp && (
        <section className="details-section">
          <h3 className="details-section__title">
            <Icon name="info" size={14} />What an editor wrote
          </h3>
          <p className="details-empty">
            This file carries an XMP packet. That is where editing history lives, and usually where a
            photographer's credit and licence live too. It is not written by the camera, and removing it
            is a separate choice from removing the camera's own record.
          </p>
          {xmp.location && (
            <Note tone="quiet">
              <strong>This packet names a location as well.</strong>{' '}
              A second copy of where the picture was taken, outside the camera block, which travels with
              any copy of the file unless it is removed when you publish.
            </Note>
          )}
          {xmp.credit && !xmp.location && (
            <Note tone="quiet">
              <strong>This packet names a person or a licence.</strong>{' '}
              Removing it removes that credit along with everything else in the packet.
            </Note>
          )}
          {!xmp.readable && (
            <Note tone="quiet">
              <strong>What is inside this one could not be read.</strong>{' '}
              It is compressed, so what it says is unknown. Removing it still removes all of it.
            </Note>
          )}
        </section>
      )}

      <section className="details-section">
        <h3 className="details-section__title"><Icon name="restore" size={14} />What it used to be</h3>
        {!history && <p className="details-empty">Reading…</p>}
        {history && history.versions.length === 0 && (
          <p className="details-empty">
            One version, the one you are looking at. Saving over this file keeps what was here
            {history.kept_days ? ` for ${history.kept_days} day${history.kept_days === 1 ? '' : 's'}` : ''}.
          </p>
        )}
        {history && history.versions.length > 0 && (
          <>
            <p className="details-hint">
              Kept{history.kept_days ? ` for ${history.kept_days} day${history.kept_days === 1 ? '' : 's'}` : ''}, and counted
              against your storage — these are your bytes too. Going back keeps what is here now, so it can be undone.
            </p>
            <ul className="version-list">
              {history.versions.map(version => (
                <li className="version-row" key={version.id}>
                  <span className="version-row__when">
                    <strong>{moment(version.made_at)}</strong>
                    <small>{bytes(version.size)}</small>
                  </span>
                  <Button kind="ghost" icon="download" onClick={() => look(version)} disabled={busy}>Save a copy</Button>
                  <Button icon="restore" onClick={() => goBack(version)} disabled={busy}>Go back to this</Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="details-section">
        <h3 className="details-section__title"><Icon name="rename" size={14} />Tags</h3>
        <p className="details-hint">Your own words. They make a file easy to find again and change nothing about who can reach it.</p>
        {error && <Note tone="bad">{error}</Note>}
        <div className="tag-row tag-row--editable">
          {tags.length === 0 && <span className="details-empty">No tags yet.</span>}
          {tags.map(tag => (
            <span className="tag-chip" key={tag.id}>
              {tag.name}
              <button
                type="button"
                className="tag-chip__remove"
                aria-label={`Remove the tag ${tag.name}`}
                disabled={busy}
                onClick={() => remove(tag)}
              ><Icon name="close" size={11} /></button>
            </span>
          ))}
        </div>
        <form className="tag-add" onSubmit={add}>
          <input
            ref={field}
            className="field__input"
            value={typed}
            maxLength={40}
            placeholder="Add a tag"
            aria-label="Add a tag"
            onChange={e => setTyped(e.target.value)}
          />
          <Button kind="solid" type="submit" icon="add" disabled={busy || !typed.trim()}>Add</Button>
        </form>
      </section>
    </Sheet>
  );
}

// f/2.8 · 1/250 · ISO 400 · 23mm, and only the parts the file actually had.
function exposure(exif) {
  const parts = [];
  if (Number.isFinite(exif.f_number)) parts.push(`f/${trim(exif.f_number)}`);
  if (Number.isFinite(exif.exposure_seconds)) {
    parts.push(exif.exposure_seconds >= 1
      ? `${trim(exif.exposure_seconds)}s`
      : `1/${Math.round(1 / exif.exposure_seconds)}`);
  }
  if (Number.isFinite(exif.iso)) parts.push(`ISO ${exif.iso}`);
  if (Number.isFinite(exif.focal_length_mm)) parts.push(`${trim(exif.focal_length_mm)}mm`);
  return parts.length ? parts.join(' · ') : null;
}

const trim = n => String(Math.round(n * 100) / 100);

function FactList({ rows }) {
  const shown = rows.filter(row => row && row[1]);
  if (!shown.length) return null;
  return (
    <dl className="fact-list">
      {shown.map(([label, value]) => (
        <div className="fact-list__row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// The chips on a card. Read-only there: the card is for recognising a file, and
// editing happens in the sheet where there is room to be wrong and undo it.
export function TagRow({ tags, max = 3 }) {
  if (!tags || !tags.length) return null;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <span className="tag-row tag-row--compact">
      {shown.map(tag => <span className="tag-chip tag-chip--small" key={tag.id}>{tag.name}</span>)}
      {rest > 0 && <span className="tag-chip tag-chip--small tag-chip--rest">+{rest}</span>}
    </span>
  );
}

// The dense grid has room for two lines and the lattice depends on that, so a
// compact card says how many words are on it and the gallery shows them. Both
// are rendered and the density decides, because the card does not know which
// grid it is in.
export function TagMark({ tags }) {
  if (!tags || !tags.length) return null;
  return (
    <span className="tag-mark" title={tags.map(tag => tag.name).join(', ')}>
      <Icon name="rename" size={10} />{tags.length}
    </span>
  );
}

// The account's own vocabulary, in the rail, as a filter. Clicking the one that
// is already on takes the filter off again.
// A strip under the toolbar rather than a panel down the side. Tags are a filter
// on what is in front of you, which is a toolbar's job; the side of the window
// was only ever where there happened to be room.
export function TagFilter({ tags, active, onPick }) {
  if (!tags || !tags.length) return null;
  return (
    <section className="tag-filter" aria-label="Filter by tag">
      <span className="tag-filter__label">Tags</span>
      <div className="tag-filter__list">
        {tags.map(tag => (
          <button
            type="button"
            key={tag.id}
            className="tag-filter__item"
            aria-pressed={active === tag.id}
            onClick={() => onPick(active === tag.id ? null : tag.id)}
          >
            <span>{tag.name}</span>
            <small>{tag.files}</small>
          </button>
        ))}
      </div>
    </section>
  );
}
