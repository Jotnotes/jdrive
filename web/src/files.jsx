// The four places, folders inside My Files, and every customer file action.
// Places are derived reach states. Filing changes where an owner looks; sharing
// and publishing change who can reach the bytes.
//
// A place is never a destination you file bytes into, so nothing here accepts a
// drop that would mean "put it in Shared". Where the desktop does accept a drag
// onto a place, the drop performs the act — delete, or open the publish
// question — and `drag.js` is the shared format both sides read.

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, saveFile } from './api.js';
import {
  Button, FileName, Icon, IconButton, Note, PLACES, PlaceMark,
  StateCrossing, bytes, makeDragImage, when,
} from './ui.jsx';
import { ShareSheet, Sheet } from './share.jsx';
import { DetailsSheet, TagFilter, TagMark, TagRow } from './details.jsx';
import { canPicture, forgetAll, thumbnailFor } from './thumbs.js';
import { FILE_DRAG, FOLDER_DRAG, draggedFiles, draggedFolders, fromOutside } from './drag.js';
import { brand } from './brand.js';
import {
  addressFor, afterUpload, bulkMenu, canAddFilesIn, fileMenu, folderMenu, nextSort, parentOf, planNotice,
  sortEntries, typeOf,
} from './fileview.js';

const TOP = 'root';

export function FilesApp({ place, borrowed = false, capabilities = null, refreshToken, onChanged, onOpen, onStatus }) {
  const [files, setFiles] = useState([]);
  const [tree, setTree] = useState([]);
  const [usage, setUsage] = useState(null);
  const [at, setAt] = useState(TOP);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedFolderIds, setSelectedFolderIds] = useState(() => new Set());
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState(null);
  const [sharing, setSharing] = useState(null);
  const [asking, setAsking] = useState(null);
  const [dropping, setDropping] = useState(false);
  const [draggingIds, setDraggingIds] = useState(() => new Set());
  // Three ways to look at the same files. The list is the one people asked for:
  // names, types, sizes and dates in columns that sort. Remembered per browser,
  // because somebody who wants a list wants it every time they open the window.
  const [density, setDensityState] = useState(() => {
    try {
      const saved = window.localStorage.getItem('files.view');
      return ['compact', 'gallery', 'list'].includes(saved) ? saved : 'compact';
    } catch { return 'compact'; }
  });
  const setDensity = value => {
    setDensityState(value);
    try { window.localStorage.setItem('files.view', value); } catch { /* private window: just not remembered */ }
  };
  const [sort, setSort] = useState({ key: 'added', dir: 'desc' });
  const [menu, setMenu] = useState(null);
  const [tags, setTags] = useState([]);
  const [tagFilter, setTagFilter] = useState(null);
  const [details, setDetails] = useState(null);
  // Finding something. `query` is what has been typed, `results` is what the box
  // answered — null when nothing has been asked, which is a different state from
  // an answer of nothing and is why the two are not one variable.
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searchTrash, setSearchTrash] = useState(false);
  const input = useRef(null);
  const searchBox = useRef(null);
  const swap = useRef(null);
  const grid = useRef(null);
  const anchor = useRef(null);
  const replaceTarget = useRef(null);
  const folderAnchor = useRef(null);

  const load = useCallback(async () => {
    try {
      const [rows, folders, report, words] = await Promise.all([
        api.files(),
        api.folders().catch(() => []),
        api.usage().catch(() => null),
        api.tags().catch(() => []),
      ]);
      setFiles(rows || []);
      setTree(folders || []);
      setUsage(report);
      setTags(words || []);
    } catch (err) { setError(err.message); }
  }, []);

  useEffect(() => { load(); }, [load, refreshToken]);
  useEffect(() => {
    if (at !== TOP && tree.length && !tree.some(folder => folder.id === at)) setAt(TOP);
  }, [tree, at]);
  useEffect(() => {
    if (tagFilter && !tags.some(tag => tag.id === tagFilter)) setTagFilter(null);
  }, [tags, tagFilter]);
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectedFolderIds(new Set());
    anchor.current = null;
    folderAnchor.current = null;
  }, [place, at, results]);

  // One request per pause in the typing rather than one per keystroke. The box
  // is answering out of an index and would survive either, but a reply that
  // arrives after a later one has already been drawn shows an answer to a
  // question that is no longer on the screen — so a stale reply is dropped
  // rather than raced.
  useEffect(() => {
    const asked = query.trim();
    if (!asked) { setResults(null); return undefined; }
    let live = true;
    const timer = setTimeout(() => {
      api.search(asked, { includeTrash: searchTrash })
        .then(answer => { if (live) setResults(answer); })
        .catch(err => { if (live) { setResults(null); setError(err.message); } });
    }, 180);
    return () => { live = false; clearTimeout(timer); };
  }, [query, searchTrash, refreshToken]);

  const counts = useMemo(() => {
    const out = { private: 0, shared: 0, public: 0, trash: 0 };
    for (const file of files) if (out[file.place] !== undefined) out[file.place] += 1;
    return out;
  }, [files]);

  // The counts and the storage meter used to live in a rail down the side of
  // this window. They are true of the account rather than of the window, so they
  // now go up to the desktop — the counts to the dock, the meter to the top bar —
  // and this window stops carrying a navigation the desktop already provides.
  useEffect(() => { if (onStatus) onStatus({ counts, usage }); }, [onStatus, counts, usage]);

  const known = useMemo(() => new Set(tree.map(folder => folder.id)), [tree]);
  const folderOf = useCallback(file => (known.has(file.folder) ? file.folder : TOP), [known]);
  const inPlace = files.filter(file => file.place === place);
  const inFolder = place === 'private' ? inPlace.filter(file => folderOf(file) === at) : inPlace;
  const searching = !!results;
  // A tag reaches across folders, because a word is not a place: filtering by
  // one looks through the whole account rather than only where you are standing.
  // A search reaches further still — across the places as well — because a
  // search that only looked where somebody happens to be standing would be a
  // filter with a longer name. So while one is running it replaces what this
  // window is showing rather than narrowing it.
  const shown = searching
    ? results.files
    : sortEntries(tagFilter
      ? files.filter(file => file.place === place && (file.tags || []).some(tag => tag.id === tagFilter))
      : inFolder, sort);
  // Filtering by a word searches files. A folder carries no words, so it is not
  // an answer to the question and it does not sit in the results pretending to be.
  // A search is the exception: a folder has a name, so it can be the answer.
  const here = searching
    ? results.folders
    : place === 'private' && !tagFilter
      ? sortEntries(tree.filter(folder => folder.parent_id === at), { key: 'name', dir: sort.key === 'name' ? sort.dir : 'asc' })
      : [];
  const crumbs = useMemo(() => pathTo(tree, at), [tree, at]);
  const selectedFiles = shown.filter(file => selectedIds.has(file.id));
  const selectedFolders = here.filter(folder => selectedFolderIds.has(folder.id));
  const picked = selectedFiles.length + selectedFolders.length;
  // The single-thing action bars are for exactly one thing. Two of anything, or
  // one of each, is the bulk bar's job.
  const chosenFile = picked === 1 && selectedFiles.length === 1 ? selectedFiles[0] : null;
  const chosenFolder = picked === 1 && selectedFolders.length === 1 ? selectedFolders[0] : null;
  const chosenFolderChildren = chosenFolder ? tree.filter(folder => folder.parent_id === chosenFolder.id).length : 0;

  const changed = async () => {
    await load();
    onChanged && onChanged();
  };

  const act = async (work, { clear = false, success = null } = {}) => {
    setBusy(true); setError(null); setFeedback(null);
    try {
      await work();
      if (clear) { setSelectedIds(new Set()); setSelectedFolderIds(new Set()); }
      if (success) setFeedback({ tone: 'good', text: success });
      await changed();
      return true;
    } catch (err) { setError(err.message); return false; }
    finally { setBusy(false); }
  };

  const runMany = async (label, targets, request, { clear = true, quiet = false, noun = 'file' } = {}) => {
    if (!targets.length) return 0;
    setBusy(true); setError(null); setFeedback(null);
    const results = await Promise.allSettled(targets.map(request));
    const failed = results.flatMap((result, index) => (result.status === 'rejected' ? [targets[index]] : []));
    const done = targets.length - failed.length;
    if (clear) setSelectedIds(new Set(failed.map(file => file.id)));
    if (failed.length) {
      const reason = results.find(result => result.status === 'rejected');
      setError(`${done} ${label}; ${failed.length} could not be. ${reason && reason.reason && reason.reason.message ? reason.reason.message : 'Nothing else changed.'}`);
    } else if (!quiet) {
      setFeedback({ tone: 'good', text: `${targets.length} ${noun}${targets.length === 1 ? '' : 's'} ${label}.` });
    }
    await changed();
    setBusy(false);
    return done;
  };

  const send = async list => {
    const queued = Array.from(list || []);
    if (!queued.length) return;
    const names = queued.map(file => file.name);
    setError(null); setFeedback(null);
    setUpload({ status: 'uploading', progress: 0, names });
    try {
      const rows = await api.upload(queued, progress => setUpload(current => current && ({ ...current, progress })), place === 'private' ? at : TOP);
      setUpload({ status: 'done', progress: 1, names });
      await changed();
      // A file added from inside Public or Shared arrives private like every
      // other file, and is then offered what that place is for. It used to say
      // "uploaded" and show an empty window, because the file had gone to My Files.
      const arrived = Array.isArray(rows) ? rows : [];
      const next = afterUpload(place);
      if (next === 'publish' && arrived.length && capabilities && capabilities.publicFiles) {
        setFeedback({ tone: 'quiet', text: `${arrived.length === 1 ? 'It is' : 'They are'} in My Files until you publish.` });
        setAsking({ kind: 'publish', files: arrived });
      } else if (next === 'share' && arrived.length && capabilities && capabilities.shareLinks) {
        setFeedback({ tone: 'quiet', text: arrived.length === 1
          ? 'It is in My Files until you give somebody a link.'
          : `The other ${arrived.length - 1} are in My Files. Give each one a link from there.` });
        setSharing(arrived[0]);
      } else if (next && arrived.length && capabilities) {
        setFeedback({ tone: 'quiet', text: capabilityNotice(capabilities) });
      }
    } catch (err) {
      setUpload({ status: 'error', progress: 0, names, error: err.message });
    }
  };

  const download = file => saveFile(file).catch(err => setError(err.message));

  // Saving over a file rather than adding another one beside it. What was there
  // is kept, so this is undoable — which is the only reason it can be offered as
  // a single button.
  const replace = async (file, chosen) => {
    if (!chosen) return;
    setError(null); setFeedback(null);
    setUpload({ status: 'uploading', progress: 0, names: [chosen.name], verb: 'replace' });
    try {
      await api.replaceFile(file.id, chosen, progress => setUpload(current => current && ({ ...current, progress })));
      setUpload({ status: 'done', progress: 1, names: [chosen.name], verb: 'replace' });
      setFeedback({ tone: 'good', text: `${file.name} was replaced. What it was is kept in its details.` });
      await changed();
    } catch (err) {
      setUpload(null);
      setError(err.message);
    }
  };
  const filesById = ids => ids.map(id => files.find(file => file.id === id)).filter(Boolean);
  const moveFiles = (ids, folderId) => runMany('moved', filesById(ids), file => api.fileInto(file.id, folderId));
  const moveFolder = (folderId, parentId) => act(() => api.moveFolder(folderId, parentId), { clear: true });

  const selectFile = (file, event) => {
    const index = shown.findIndex(item => item.id === file.id);
    if (!(event.metaKey || event.ctrlKey || event.shiftKey)) setSelectedFolderIds(new Set());
    setSelectedIds(previous => {
      const modified = event.metaKey || event.ctrlKey;
      if (event.shiftKey && anchor.current) {
        const start = shown.findIndex(item => item.id === anchor.current);
        if (start !== -1) {
          const next = modified ? new Set(previous) : new Set();
          for (let i = Math.min(start, index); i <= Math.max(start, index); i += 1) next.add(shown[i].id);
          return next;
        }
      }
      anchor.current = file.id;
      if (modified) {
        const next = new Set(previous);
        next.has(file.id) ? next.delete(file.id) : next.add(file.id);
        return next;
      }
      return new Set([file.id]);
    });
  };

  // The same rules as a file: click replaces, cmd or ctrl adds one, shift takes
  // the run between. Folders and files select together, because "these four
  // things" is a thought people have and having to do it twice is the product
  // arguing with them.
  const selectFolder = (folder, event) => {
    const index = here.findIndex(item => item.id === folder.id);
    setSelectedFolderIds(previous => {
      const modified = event.metaKey || event.ctrlKey;
      if (event.shiftKey && folderAnchor.current) {
        const start = here.findIndex(item => item.id === folderAnchor.current);
        if (start !== -1) {
          const next = modified ? new Set(previous) : new Set();
          for (let i = Math.min(start, index); i <= Math.max(start, index); i += 1) next.add(here[i].id);
          return next;
        }
      }
      folderAnchor.current = folder.id;
      if (modified) {
        const next = new Set(previous);
        next.has(folder.id) ? next.delete(folder.id) : next.add(folder.id);
        return next;
      }
      return new Set([folder.id]);
    });
    if (!(event.metaKey || event.ctrlKey || event.shiftKey)) setSelectedIds(new Set());
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectedFolderIds(new Set());
    anchor.current = null;
    folderAnchor.current = null;
  };

  // Every card in the grid, in the order they are drawn: folders first, then
  // files. Read off the DOM rather than kept in state, because the DOM is what
  // the arrow keys are actually moving through.
  const cardsInGrid = () => Array.from(grid.current ? grid.current.querySelectorAll('[data-grid-card]') : []);

  const selectCard = (card, { add = false } = {}) => {
    const id = card.getAttribute('data-id');
    const kind = card.getAttribute('data-kind');
    if (!id) return;
    if (kind === 'folder') {
      setSelectedFolderIds(previous => (add ? new Set([...previous, id]) : new Set([id])));
      if (!add) setSelectedIds(new Set());
      folderAnchor.current = id;
    } else {
      setSelectedIds(previous => (add ? new Set([...previous, id]) : new Set([id])));
      if (!add) setSelectedFolderIds(new Set());
      anchor.current = id;
    }
  };

  const gridKeys = event => {
    const tag = event.target && event.target.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || event.target.isContentEditable) return;
    if (event.altKey && event.key === 'ArrowUp' && place === 'private' && at !== TOP) {
      event.preventDefault();
      setAt(parentOf(tree, at));
      clearSelection();
      return;
    }
    const modified = event.metaKey || event.ctrlKey;

    if (event.key === '?' || (event.shiftKey && event.key === '/')) {
      event.preventDefault();
      setAsking({ kind: 'shortcuts' });
      return;
    }
    if (modified && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelectedIds(new Set(shown.map(file => file.id)));
      setSelectedFolderIds(new Set(here.map(folder => folder.id)));
      return;
    }
    if (event.key === 'Escape') { clearSelection(); return; }

    // Backspace as well as Delete: on a laptop keyboard the key with the arrow
    // on it is Backspace, and it is the one every file product uses.
    if ((event.key === 'Delete' || event.key === 'Backspace') && (selectedFiles.length || selectedFolders.length)) {
      event.preventDefault();
      if (place === 'trash') return;
      if (place === 'public') { setError('Take a public file off the internet before moving it to Trash.'); return; }
      if (!selectedFiles.length) {
        setError('A folder is deleted rather than put in the Trash, and only once it is empty.');
        return;
      }
      if (selectedFolders.length) {
        setFeedback({ tone: 'quiet', text: 'Folders are not put in the Trash; empty one and delete it instead.' });
      }
      runMany('moved to Trash', selectedFiles, file => api.trash(file.id));
      return;
    }
    if (event.key === 'F2' && chosenFolder) {
      event.preventDefault();
      setAsking({ kind: 'rename', folder: chosenFolder });
      return;
    }
    if (event.key === 'F2' && chosenFile) {
      event.preventDefault();
      setAsking({ kind: 'renameFile', file: chosenFile });
      return;
    }

    const cards = cardsInGrid();
    const active = cards.indexOf(document.activeElement);
    if (active < 0 || !cards.length) return;

    // Space picks up the thing under the cursor without opening it, which is
    // how somebody builds a selection that is not a run.
    if (event.key === ' ') {
      event.preventDefault();
      selectCard(cards[active], { add: true });
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const firstTop = cards[0].offsetTop;
    const columns = Math.max(1, cards.filter(card => card.offsetTop === firstTop).length);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
    const target = event.key === 'Home' ? 0
      : event.key === 'End' ? cards.length - 1
        : Math.max(0, Math.min(cards.length - 1, active + step));
    const card = cards[target];
    card.focus();
    // Moving takes the selection with it, which is what makes arrow keys worth
    // having: before this, arrowing to a file and pressing Delete deleted the
    // one somewhere behind you that was still selected. Holding cmd moves the
    // focus alone; holding shift adds what you land on to what you have.
    if (!modified) selectCard(card, { add: event.shiftKey });
  };

  const startFileDrag = (event, file) => {
    const inSelection = selectedIds.has(file.id);
    const ids = inSelection ? Array.from(selectedIds) : [file.id];
    // Dragging one file out of a selection of five carries the five. Dragging
    // something that was not selected picks it up on its own, which is what
    // every file product does and what a hand expects.
    const folderIds = inSelection ? Array.from(selectedFolderIds) : [];
    if (!inSelection) { setSelectedIds(new Set([file.id])); setSelectedFolderIds(new Set()); }
    event.dataTransfer.setData(FILE_DRAG, JSON.stringify(ids));
    if (folderIds.length) event.dataTransfer.setData(FOLDER_DRAG, JSON.stringify(folderIds));
    event.dataTransfer.effectAllowed = 'move';
    setDraggingIds(new Set(ids));
    makeDragImage(event, file.name, ids.length + folderIds.length);
  };

  const startFolderDrag = (event, folder) => {
    const inSelection = selectedFolderIds.has(folder.id);
    const folderIds = inSelection ? Array.from(selectedFolderIds) : [folder.id];
    const ids = inSelection ? Array.from(selectedIds) : [];
    if (!inSelection) { setSelectedFolderIds(new Set([folder.id])); setSelectedIds(new Set()); }
    event.dataTransfer.setData(FOLDER_DRAG, JSON.stringify(folderIds));
    if (ids.length) event.dataTransfer.setData(FILE_DRAG, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'move';
    makeDragImage(event, folder.name, folderIds.length + ids.length, 'folder');
  };

  // Right-click. What was clicked becomes the selection unless it was already
  // part of one, which is how every desktop file manager behaves: right-clicking
  // one of five selected files acts on the five.
  const openMenu = (event, kind, target) => {
    event.preventDefault();
    event.stopPropagation();
    const box = event.currentTarget && event.currentTarget.getBoundingClientRect ? event.currentTarget.getBoundingClientRect() : null;
    const x = event.clientX || (box ? box.left + 24 : 0);
    const y = event.clientY || (box ? box.top + 24 : 0);
    let many = false;
    if (kind === 'file') {
      if (selectedIds.has(target.id)) many = picked > 1;
      else { setSelectedIds(new Set([target.id])); setSelectedFolderIds(new Set()); anchor.current = target.id; }
    } else {
      if (selectedFolderIds.has(target.id)) many = picked > 1;
      else { setSelectedFolderIds(new Set([target.id])); setSelectedIds(new Set()); folderAnchor.current = target.id; }
    }
    setMenu({ x, y, kind: many ? 'bulk' : kind, target });
  };

  // One place that knows what each action does, for the action bar and the menu.
  const copyAddress = async file => {
    const address = addressFor(file);
    if (!address) return;
    try { await navigator.clipboard.writeText(address); setFeedback({ tone: 'good', text: 'Address copied.' }); }
    catch { setFeedback({ tone: 'quiet', text: `Your browser would not copy it. The address is ${address}` }); }
  };
  const runItem = (key, target) => {
    setMenu(null);
    switch (key) {
      case 'open': return onOpen(target);
      case 'download': return download(target);
      case 'details': return setDetails(target);
      case 'rename': return setAsking({ kind: 'renameFile', file: target });
      case 'replace': replaceTarget.current = target; return swap.current && swap.current.click();
      case 'share': return setSharing(target);
      case 'move': return setAsking({ kind: 'moveFiles', files: [target] });
      case 'unpublish': return act(() => api.unpublish(target.id));
      case 'copyAddress': return copyAddress(target);
      case 'publish': return setAsking({ kind: 'publish', files: [target] });
      case 'trash':
        if (target.place === 'public') return setAsking({ kind: 'takeDownTrash', files: [target] });
        return act(() => api.trash(target.id), { clear: true });
      case 'restore': return act(() => api.restore(target.id), { clear: true });
      case 'enter': setAt(target.id); return clearSelection();
      case 'renameFolder': return setAsking({ kind: 'rename', folder: target });
      case 'moveFolder': return setAsking({ kind: 'moveFolder', folder: target });
      case 'deleteFolder': return act(() => api.removeFolder(target.id), { clear: true });
      case 'moveMany': return setAsking({ kind: 'moveMany', files: selectedFiles, folders: selectedFolders });
      case 'unshareAll': return runMany('returned to My Files', selectedFiles, file => api.unshare(file.id));
      case 'unpublishAll': return runMany('taken off the internet', selectedFiles, file => api.unpublish(file.id));
      case 'publishAll': return setAsking({ kind: 'publish', files: selectedFiles });
      case 'trashAll':
        if (place === 'public') return setAsking({ kind: 'takeDownTrash', files: selectedFiles });
        if (selectedFolders.length) setFeedback({ tone: 'quiet', text: 'Folders are not put in the Trash; empty one and delete it instead.' });
        return runMany('moved to Trash', selectedFiles, file => api.trash(file.id));
      case 'restoreAll': return runMany('restored', selectedFiles, file => api.restore(file.id));
      default: return undefined;
    }
  };

  const menuOptions = {
    borrowed,
    canShare: !!(capabilities && capabilities.shareLinks),
    canPublish: !!(capabilities && capabilities.publicFiles),
  };
  const unavailable = capabilities && !borrowed
    ? capabilityNotice(capabilities)
    : null;

  // Moving several folders is several requests, and one of them can be refused
  // for a reason that does not apply to the others — a folder cannot go inside
  // itself, and in a multiple selection one of them might be the destination.
  const moveFolders = (ids, parentId, options = {}) => {
    const targets = ids.map(id => tree.find(folder => folder.id === id)).filter(Boolean)
      .filter(folder => folder.id !== parentId);
    if (!targets.length) return 0;
    return runMany('moved', targets, folder => api.moveFolder(folder.id, parentId), { noun: 'folder', ...options });
  };

  return (
    <div
      className="files-app"
      onKeyDown={gridKeys}
      onDragOver={event => { if (fromOutside(event) && canAddFilesIn(place)) { event.preventDefault(); setDropping(true); } }}
      onDragLeave={event => { if (event.currentTarget === event.target) setDropping(false); }}
      onDrop={event => { if (fromOutside(event) && canAddFilesIn(place)) { event.preventDefault(); setDropping(false); send(event.dataTransfer.files); } }}
    >
      <main className="files-main">
        <header className="files-toolbar">
          <div className="files-toolbar__location">
            <PlaceMark place={place} compact />
            {/* The way out of a folder, where people look for it. The trail beside
                it already worked, but nothing about grey text says "click me", and
                on a live box somebody went into a folder and could not get back. */}
            {place === 'private' && crumbs.length > 0
              ? (
                // Back and the trail share one row. The header is a two-row grid —
                // the place mark beside a title and a line under it — and the Back
                // button as a grid item of its own pushed the trail onto a third row.
                <div className="files-toolbar__trail">
                  {at !== TOP && !searching && !tagFilter && (
                    <IconButton label="Back" icon="back" onClick={() => { setAt(parentOf(tree, at)); clearSelection(); }} />
                  )}
                  <Crumbs crumbs={crumbs} onGo={id => { setAt(id); clearSelection(); }} onDropFiles={moveFiles} onDropFolder={moveFolders} />
                </div>
              )
              : <h1>{PLACES[place].label}</h1>}
            <span>{searching
              ? searchSentence(results, searchTrash)
              : tagFilter
                ? `Tagged ${(tags.find(tag => tag.id === tagFilter) || {}).name || ''}, across every folder`
                : place === 'private' && crumbs.length ? PLACES.private.hint : PLACES[place].detail}</span>
          </div>
          <div className="files-toolbar__actions">
            <div className="files-search" data-active={searching}>
              <Icon name="search" size={15} />
              <input
                ref={searchBox}
                type="search"
                value={query}
                placeholder="Find by name or tag"
                aria-label="Find a file, folder or tag by name"
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  // Escape empties the box rather than closing the window, and
                  // stops there: the shortcut layer below treats it as clear-the-
                  // selection, which would read as the key doing two things.
                  if (event.key === 'Escape') { event.stopPropagation(); setQuery(''); }
                }}
              />
              {query && (
                <IconButton label="Clear the search" icon="close"
                  onClick={() => { setQuery(''); if (searchBox.current) searchBox.current.focus(); }} />
              )}
            </div>
            <IconButton label="Keyboard shortcuts" icon="info" onClick={() => setAsking({ kind: 'shortcuts' })} />
            <div className="density-toggle" role="group" aria-label="File density">
              <IconButton label="Compact grid" icon="compact" pressed={density === 'compact'} onClick={() => setDensity('compact')} />
              <IconButton label="Gallery grid" icon="gallery" pressed={density === 'gallery'} onClick={() => setDensity('gallery')} />
              <IconButton label="List with details" icon="list" pressed={density === 'list'} onClick={() => setDensity('list')} />
            </div>
            {place === 'trash' && shown.length > 0 && (
              <Button kind="danger" onClick={() => setAsking({ kind: 'empty' })} disabled={busy}>Empty Trash</Button>
            )}
            {place === 'private' && (
              <Button icon="newFolder" onClick={() => setAsking({ kind: 'newFolder' })} disabled={busy}>New folder</Button>
            )}
            {canAddFilesIn(place) && (
              <Button kind="solid" icon="add" onClick={() => input.current && input.current.click()}>Add files</Button>
            )}
            <input ref={input} type="file" multiple hidden onChange={event => { send(event.target.files); event.target.value = ''; }} />
            <input ref={swap} type="file" hidden
              onChange={event => {
                const picked = event.target.files[0];
                event.target.value = '';
                const target = replaceTarget.current || chosenFile;
                replaceTarget.current = null;
                if (target) replace(target, picked);
              }} />
          </div>
        </header>

        {searching
          ? <SearchBar results={results} includeTrash={searchTrash} onIncludeTrash={setSearchTrash} onWord={setQuery} />
          : <TagFilter tags={tags} active={tagFilter} onPick={setTagFilter} />}

        {upload && <UploadShelf upload={upload} onClose={() => setUpload(null)} />}

        {(error || feedback) && (
          <div className="files-messages">
            {error ? <Note tone="bad">{error}</Note> : null}
            {feedback ? <Note tone={feedback.tone}>{feedback.text}</Note> : null}
          </div>
        )}

        <div className="files-scroll" onPointerDown={event => event.target === event.currentTarget && clearSelection()}>
          {shown.length === 0 && here.length === 0
            ? searching
              ? <NothingMatched query={results.query} includeTrash={searchTrash} onIncludeTrash={setSearchTrash} />
              : <Empty place={place} counts={counts} inFolder={at !== TOP} onAdd={canAddFilesIn(place) ? () => input.current && input.current.click() : null} />
            : density === 'list' ? (
              <FileList
                listRef={grid}
                place={place}
                folders={here}
                files={shown}
                sort={searching ? null : sort}
                onSort={key => setSort(current => nextSort(current, key))}
                tree={tree}
                selectedIds={selectedIds}
                selectedFolderIds={selectedFolderIds}
                draggingIds={draggingIds}
                onSelectFile={selectFile}
                onOpenFile={file => onOpen(file)}
                onFileDrag={startFileDrag}
                onFileDragEnd={() => setDraggingIds(new Set())}
                onSelectFolder={selectFolder}
                onEnterFolder={folder => { setQuery(''); setAt(folder.id); clearSelection(); }}
                onFolderDrag={startFolderDrag}
                onDropFiles={moveFiles}
                onDropFolder={moveFolders}
                onMenu={openMenu}
                onItem={runItem}
              />
            ) : (
              <div ref={grid} className={`asset-grid asset-grid--${density}`} role="grid" aria-label={`${PLACES[place].label} files`}>
                {here.map((folder, index) => {
                  const childFolders = tree.filter(item => item.parent_id === folder.id).length;
                  return (
                    <FolderCard
                      key={folder.id}
                      index={index}
                      folder={folder}
                      childFolders={childFolders}
                      selected={selectedFolderIds.has(folder.id)}
                      onSelect={event => selectFolder(folder, event)}
                      onEnter={() => { setQuery(''); setAt(folder.id); clearSelection(); }}
                      onRename={() => setAsking({ kind: 'rename', folder })}
                      onDragStart={event => startFolderDrag(event, folder)}
                      onDropFiles={moveFiles}
                      onDropFolder={moveFolders}
                      onMenu={event => openMenu(event, 'folder', folder)}
                    />
                  );
                })}
                {shown.map((file, index) => (
                  <FileCard
                    key={file.id}
                    index={here.length + index}
                    file={file}
                    selected={selectedIds.has(file.id)}
                    dragging={draggingIds.has(file.id)}
                    onSelect={event => selectFile(file, event)}
                    onOpen={() => onOpen(file)}
                    onDragStart={event => startFileDrag(event, file)}
                    onDragEnd={() => setDraggingIds(new Set())}
                    onMenu={event => openMenu(event, 'file', file)}
                    reason={file.matched}
                  />
                ))}
              </div>
            )}
        </div>

        {picked > 1 && (
          <ItemBar
            label={selectedFolders.length
              ? [selectedFiles.length ? `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}` : null,
                `${selectedFolders.length} folder${selectedFolders.length === 1 ? '' : 's'}`].filter(Boolean).join(' and ')
              : `${selectedFiles.length} selected`}
            count={picked}
            items={bulkMenu({ place, files: selectedFiles.length, folders: selectedFolders.length,
              canFile: tree.length > 0 || at !== TOP, canPublish: menuOptions.canPublish })}
            detail={selectedFolders.length ? 'Folders move but are never trashed' : null}
            busy={busy}
            onItem={key => runItem(key, null)}
          />
        )}

        {chosenFile && (
          <ItemBar
            label={chosenFile.name}
            count={1}
            items={fileMenu(chosenFile, { ...menuOptions, canFile: place === 'private' && (tree.length > 0 || at !== TOP) })}
            detail={chosenFile.place === 'trash' ? `Deleted ${when(chosenFile.deleted_at)}`
              : chosenFile.place !== 'public' ? unavailable : null}
            busy={busy}
            onItem={key => runItem(key, chosenFile)}
          />
        )}

        {chosenFolder && (
          <ItemBar
            label={chosenFolder.name}
            count={1}
            items={folderMenu(chosenFolder, { childFolders: chosenFolderChildren })}
            detail={Number(chosenFolder.files) + chosenFolderChildren ? 'Empty it before it can go' : 'Empty'}
            busy={busy}
            onItem={key => runItem(key, chosenFolder)}
          />
        )}
      </main>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.kind === 'bulk'
            ? bulkMenu({ place, files: selectedFiles.length, folders: selectedFolders.length,
              canFile: tree.length > 0 || at !== TOP, canPublish: menuOptions.canPublish })
            : menu.kind === 'folder'
              ? folderMenu(menu.target, { childFolders: tree.filter(item => item.parent_id === menu.target.id).length })
              : fileMenu(menu.target, { ...menuOptions, canFile: place === 'private' && (tree.length > 0 || at !== TOP) })}
          onItem={key => runItem(key, menu.kind === 'bulk' ? null : menu.target)}
          onClose={() => setMenu(null)}
        />
      )}

      {dropping && (
        <div className="drop-curtain">
          <span><Icon name="upload" size={24} /></span>
          <strong>{place === 'private' && at !== TOP ? `Add to ${nameOf(tree, at)}` : 'Add to My Files'}</strong>
          <small>{afterUpload(place) === 'publish' && capabilities && !capabilities.publicFiles
            ? capabilityNotice(capabilities)
            : afterUpload(place) === 'share' && capabilities && !capabilities.shareLinks
              ? capabilityNotice(capabilities)
              : afterUpload(place) === 'publish'
            ? 'They arrive private, then you choose whether to publish them.'
            : afterUpload(place) === 'share'
              ? 'They arrive private, then you give somebody a link.'
              : 'The files stay private when they arrive.'}</small>
        </div>
      )}

      {sharing && (
        <ShareSheet
          file={sharing}
          canCreate={menuOptions.canShare}
          unavailable={capabilities ? capabilityNotice(capabilities, 'share') : null}
          onClose={() => setSharing(null)}
          onChanged={load}
        />
      )}

      {details && (
        <DetailsSheet
          file={files.find(file => file.id === details.id) || details}
          folderName={nameOf(tree, folderOf(details))}
          onClose={() => setDetails(null)}
          onChanged={load}
        />
      )}

      {asking && asking.kind === 'newFolder' && (
        <NameSheet title="New folder" action="Make folder" onClose={() => setAsking(null)}
          onDone={name => { setAsking(null); return act(() => api.newFolder(name, at)); }} />
      )}

      {asking && asking.kind === 'rename' && (
        <NameSheet title="Rename folder" eyebrow={asking.folder.name} action="Rename" initial={asking.folder.name}
          onClose={() => setAsking(null)} onDone={name => { setAsking(null); return act(() => api.renameFolder(asking.folder.id, name)); }} />
      )}

      {asking && asking.kind === 'renameFile' && (
        <NameSheet title="Rename file" eyebrow={asking.file.name} action="Rename" initial={stemOf(asking.file.name)}
          note={extensionOf(asking.file.name)
            ? `The ${extensionOf(asking.file.name)} stays: it is part of what the file is, not what it is called.`
            : undefined}
          onClose={() => setAsking(null)}
          onDone={name => { setAsking(null); return act(() => api.renameFile(asking.file.id, name)); }} />
      )}

      {asking && (asking.kind === 'moveFiles' || asking.kind === 'moveMany') && (
        <MoveManySheet
          files={asking.files || []}
          folders={asking.folders || []}
          tree={tree}
          at={asking.files && asking.files.length ? folderOf(asking.files[0]) : TOP}
          onClose={() => setAsking(null)}
          onDone={async folder => {
            const ids = (asking.files || []).map(file => file.id);
            const folderIds = (asking.folders || []).map(item => item.id);
            setAsking(null);
            // Two passes, one sentence. Reporting each pass in turn meant the
            // second overwrote the first, and moving a file and two folders said
            // "1 file moved" — true, and a third of the truth.
            const movedFolders = folderIds.length ? await moveFolders(folderIds, folder, { quiet: true }) : 0;
            const movedFiles = ids.length ? await runMany('moved', filesById(ids), file => api.fileInto(file.id, folder), { quiet: true }) : 0;
            const said = [
              movedFiles ? `${movedFiles} file${movedFiles === 1 ? '' : 's'}` : null,
              movedFolders ? `${movedFolders} folder${movedFolders === 1 ? '' : 's'}` : null,
            ].filter(Boolean).join(' and ');
            if (said) setFeedback({ tone: 'good', text: `${said} moved.` });
          }}
        />
      )}

      {asking && asking.kind === 'shortcuts' && <ShortcutSheet onClose={() => setAsking(null)} />}

      {asking && asking.kind === 'moveFolder' && (
        <MoveFolderSheet folder={asking.folder} tree={tree} onClose={() => setAsking(null)}
          onDone={parent => { setAsking(null); return moveFolder(asking.folder.id, parent); }} />
      )}

      {asking && asking.kind === 'publish' && (
        <PublishSheet files={asking.files} onClose={() => setAsking(null)} onPublish={remove => {
          const targets = asking.files;
          setAsking(null);
          return runMany('published', targets, file => api.publish(file.id, {
            exif: remove.exif.includes(file.id), xmp: remove.xmp.includes(file.id),
          }));
        }} />
      )}

      {asking && asking.kind === 'takeDownTrash' && (
        <Sheet title="Take it off the internet first?" onClose={() => setAsking(null)} tone="var(--danger)">
          <h3 className="sheet-question">
            {asking.files.length === 1 ? `${asking.files[0].name} is on the internet.` : `${asking.files.length} of these are on the internet.`}
          </h3>
          <p className="sheet-copy">
            Moving {asking.files.length === 1 ? 'it' : 'them'} to the Trash takes {asking.files.length === 1 ? 'it' : 'them'} off
            first, so the public address stops working straight away. You can restore from the Trash; the address
            will not come back unless you publish again.
          </p>
          <div className="sheet-actions">
            <Button kind="solid" tone="var(--danger)" onClick={() => {
              const targets = asking.files;
              setAsking(null);
              runMany('taken off the internet and moved to Trash', targets, async file => {
                await api.unpublish(file.id);
                await api.trash(file.id);
              });
            }}>Take {asking.files.length === 1 ? 'it' : 'them'} off and move to Trash</Button>
            <Button onClick={() => setAsking(null)}>Keep {asking.files.length === 1 ? 'it' : 'them'} published</Button>
          </div>
        </Sheet>
      )}

      {asking && asking.kind === 'empty' && (
        <Sheet title="Empty Trash?" onClose={() => setAsking(null)} tone="var(--danger)">
          <div className="irreversible-mark"><Icon name="warning" size={22} /></div>
          <h3 className="sheet-question">Remove {shown.length} file{shown.length === 1 ? '' : 's'} for good?</h3>
          <Note tone="bad">This is the only thing here that cannot be undone. The files will be removed from the disk.</Note>
          <div className="sheet-actions">
            <Button kind="solid" tone="var(--danger)" onClick={() => { setAsking(null); act(async () => { await api.emptyTrash(); forgetAll(); }, { clear: true }); }}>Empty it</Button>
            <Button onClick={() => setAsking(null)}>Keep them</Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function capabilityNotice(capabilities, feature = null) {
  const contact = brand.support
    ? (brand.supportLabel && brand.supportLabel !== 'Get help' ? brand.supportLabel : 'your provider\u2019s support team')
    : 'your provider';
  const shown = feature === 'share' ? { shareLinks: capabilities.shareLinks }
    : feature === 'public' ? { publicFiles: capabilities.publicFiles }
      : capabilities;
  return planNotice(shown, contact);
}

function UploadShelf({ upload, onClose }) {
  const total = upload.names.length;
  const label = total === 1 ? upload.names[0] : `${upload.names[0]} and ${total - 1} more`;
  // Adding a file and saving over one use the same shelf, because they are the
  // same transfer. They are not the same event to the person watching it, and a
  // replace that reports itself as an upload is the box describing the wrong
  // thing at the one moment somebody is checking it did the right thing.
  const doing = upload.verb === 'replace' ? 'Replacing' : 'Uploading';
  const done = upload.verb === 'replace' ? 'replaced' : 'uploaded';
  return (
    <section className={`upload-shelf upload-shelf--${upload.status}`} aria-live="polite">
      <span className="upload-shelf__icon"><Icon name={upload.status === 'error' ? 'warning' : upload.status === 'done' ? 'check' : 'upload'} size={17} /></span>
      <div className="upload-shelf__copy">
        <strong>{upload.status === 'uploading' ? `${doing} ${label}` : upload.status === 'done' ? `${label} ${done}` : `${label} could not be ${done}`}</strong>
        <span>{upload.status === 'error' ? upload.error : `${Math.round(upload.progress * 100)}% · ${total} file${total === 1 ? '' : 's'}`}</span>
      </div>
      <div className="upload-shelf__track"><span style={{ width: `${Math.round(upload.progress * 100)}%` }} /></div>
      {upload.status !== 'uploading' && <button type="button" onClick={onClose} aria-label="Dismiss upload status"><Icon name="close" size={15} /></button>}
    </section>
  );
}

function pathTo(tree, id) {
  const out = [];
  let current = id;
  const seen = new Set();
  while (current && current !== TOP && !seen.has(current)) {
    seen.add(current);
    const row = tree.find(folder => folder.id === current);
    if (!row) break;
    out.unshift(row);
    current = row.parent_id;
  }
  return out;
}

const nameOf = (tree, id) => (tree.find(folder => folder.id === id) || {}).name || 'My Files';

function Crumbs({ crumbs, onGo, onDropFiles, onDropFolder }) {
  const [over, setOver] = useState(null);
  const drop = id => event => {
    event.preventDefault(); setOver(null);
    const ids = draggedFiles(event);
    if (ids.length) return onDropFiles(ids, id);
    const folders = draggedFolders(event);
    if (folders.length) onDropFolder(folders, id);
  };
  const crumb = (label, id, last) => (
    <span key={id} className="crumb-wrap">
      <button type="button" onClick={() => onGo(id)} data-current={last} data-over={over === id}
        onDragOver={event => { if (!fromOutside(event)) { event.preventDefault(); setOver(id); } }}
        onDragLeave={() => setOver(null)} onDrop={drop(id)}>{label}</button>
      {!last && <Icon name="chevron" size={12} />}
    </span>
  );
  return <div className="breadcrumbs">{crumb('My Files', TOP, crumbs.length === 0)}{crumbs.map((folder, index) => crumb(folder.name, folder.id, index === crumbs.length - 1))}</div>;
}

function FolderCard({ folder, childFolders, selected, index, onSelect, onEnter, onRename, onDragStart, onDropFiles, onDropFolder, onMenu }) {
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      draggable
      data-grid-card
      data-grid-index={index}
      data-kind="folder"
      data-id={folder.id}
      data-selected={selected}
      data-drop={over}
      role="gridcell"
      aria-selected={selected}
      className="asset-card asset-card--folder"
      onDragStart={onDragStart}
      onDragOver={event => { if (!fromOutside(event)) { event.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={event => {
        event.preventDefault(); event.stopPropagation(); setOver(false);
        const ids = draggedFiles(event);
        if (ids.length) return onDropFiles(ids, folder.id);
        const moved = draggedFolders(event).filter(id => id !== folder.id);
        if (moved.length) onDropFolder(moved, folder.id);
      }}
      onClick={onSelect}
      onDoubleClick={onEnter}
      onContextMenu={onMenu}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); onEnter(); }
        if (event.key === 'F2') { event.preventDefault(); onRename(); }
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) onMenu(event);
      }}
    >
      <div className="asset-card__preview folder-preview"><Icon name="folder" size={36} /></div>
      <div className="asset-card__body">
        <strong className="folder-name" title={folder.name}>{folder.name}</strong>
        <span>{folder.files ? `${folder.files} file${folder.files === 1 ? '' : 's'}` : 'No files'}{childFolders ? ` · ${childFolders} folder${childFolders === 1 ? '' : 's'}` : ''}</span>
      </div>
      {over && <span className="asset-card__drop">Move here</span>}
      {selected && <span className="asset-card__check"><Icon name="check" size={12} /></span>}
    </button>
  );
}

function FileCard({ file, selected, dragging, index, onSelect, onOpen, onDragStart, onDragEnd, onMenu, reason = null }) {
  const card = useRef(null);
  const [visible, setVisible] = useState(false);
  const [thumb, setThumb] = useState({ state: 'idle', src: null });
  const place = PLACES[file.place] || PLACES.private;

  useEffect(() => {
    const node = card.current;
    if (!node || visible) return undefined;
    if (typeof IntersectionObserver !== 'function') { setVisible(true); return undefined; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '180px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    setThumb({ state: canPicture(file) ? 'loading' : 'empty', src: null });
    thumbnailFor(file).then(src => { if (alive) setThumb({ state: src ? 'ready' : 'empty', src }); })
      .catch(() => { if (alive) setThumb({ state: 'error', src: null }); });
    return () => { alive = false; };
  }, [visible, file.id, file.thumbnail, file.mime, file.size]);

  return (
    <button
      ref={card}
      type="button"
      draggable
      data-grid-card
      data-grid-index={index}
      data-kind="file"
      data-id={file.id}
      data-selected={selected}
      data-dragging={dragging}
      data-loading={thumb.state === 'loading'}
      data-error={thumb.state === 'error'}
      role="gridcell"
      aria-selected={selected}
      aria-label={`${file.name}, ${place.label}, ${bytes(file.size)}, added ${when(file.added_at)}`}
      className="asset-card asset-card--file"
      style={{ '--place': place.tone, '--place-soft': place.wash }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onMenu}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); onOpen(); }
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) onMenu(event);
      }}
    >
      <div className="asset-card__preview file-preview">
        {thumb.src
          ? <img src={thumb.src} alt="" loading="lazy" draggable={false} />
          : thumb.state === 'loading'
            ? <span className="thumb-skeleton" />
            : <FileType file={file} />}
        <span className="asset-card__state"><Icon name={place.icon} size={11} />{place.label}</span>
      </div>
      <div className="asset-card__body">
        <FileName name={file.name} />
        <span className="asset-card__meta">
          <span>{bytes(file.size)}</span>
          <TagMark tags={file.tags} />
          <span>{when(file.added_at)}</span>
        </span>
        <TagRow tags={file.tags} />
        {reason && reason.how === 'tag' && reason.tag && (
          // A file whose name has nothing to do with what was typed, sitting in
          // the results because it wears a matching tag, reads as a broken search
          // until it says so.
          <span className="asset-card__why"><Icon name="check" size={11} />Tagged {reason.tag.name}</span>
        )}
      </div>
      {selected && <span className="asset-card__check"><Icon name="check" size={12} /></span>}
    </button>
  );
}

// What the answer amounts to, in a sentence. Counted rather than described,
// because "some files" is not an answer to "did it find mine".
function searchSentence(results, includeTrash) {
  const files = results.files.length;
  const folders = results.folders.length;
  const parts = [
    `${files} file${files === 1 ? '' : 's'}`,
    folders ? `${folders} folder${folders === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return `${parts.join(' and ')} matching ${results.query}, across every place${includeTrash ? ', the Trash included' : ''}`;
}

function SearchBar({ results, includeTrash, onIncludeTrash, onWord }) {
  return (
    <div className="files-search-bar">
      <span className="files-search-bar__label">Found</span>
      <div className="files-search-bar__words">
        {/* The words this actually searched for, because what a person typed and
            what a search ran are not always the same thing: punctuation is
            dropped, and anything past the length cap never reached the box. */}
        {results.words.map(word => <span key={word} className="files-search-bar__word">{word}</span>)}
        {/* A tag is worth offering when it is something the person has not already
            typed — searching `quar` and being shown the tag `quarterly-review` is
            useful. Offering `harbour` to somebody who typed `harbour` is the same
            word twice in a row, which reads as a bug rather than as a shortcut. */}
        {results.tags
          .filter(tag => !results.words.some(word => word.toLowerCase() === tag.name.toLowerCase()))
          .map(tag => (
            <button key={tag.id} type="button" className="files-search-bar__tag"
              onClick={() => onWord(tag.name)} title={`Search for the tag ${tag.name}`}>
              <Icon name="check" size={11} />{tag.name}
            </button>
          ))}
      </div>
      <label className="files-search-bar__trash">
        <input type="checkbox" checked={includeTrash} onChange={event => onIncludeTrash(event.target.checked)} />
        Include the Trash
      </label>
      {results.truncated && (
        <span className="files-search-bar__more">
          The first {results.limit}. Add a word to narrow it.
        </span>
      )}
    </div>
  );
}

function NothingMatched({ query, includeTrash, onIncludeTrash }) {
  return (
    <div className="empty-state" style={{ '--place': PLACES.private.tone, '--place-soft': PLACES.private.wash }}>
      <span className="empty-state__icon"><Icon name="search" size={25} /></span>
      <h2>Nothing matches {query}</h2>
      <p>Names of files, names of folders, and the words you have put on things. Not what is inside them.</p>
      {!includeTrash && <Button onClick={() => onIncludeTrash(true)}>Look in the Trash as well</Button>}
    </div>
  );
}

function FileType({ file }) {
  const extension = (file.name.split('.').pop() || 'file').slice(0, 5).toUpperCase();
  return <span className="file-type"><Icon name="file" size={26} /><strong>{extension}</strong></span>;
}

const extensionOf = name => {
  const text = String(name || '');
  const at = text.lastIndexOf('.');
  return at > 0 && at < text.length - 1 ? text.slice(at) : '';
};
const stemOf = name => {
  const keep = extensionOf(name);
  return keep ? String(name).slice(0, -keep.length) : String(name || '');
};

// `borrowed` hides the three actions a borrowed session is refused, rather than
// leaving buttons that always fail. The box refuses them either way — this is
// the interface agreeing with the box instead of arguing with it, which is the
// difference between a boundary and a bug report.
// The action bar under the files: one list, drawn as buttons. The same list is what
// the right-click menu draws, from fileview.js, so the two can never offer
// different things for the same file.
const TONES = { shared: PLACES.shared.tone, public: PLACES.public.tone };
function ItemBar({ label, count, items, detail = null, busy, onItem }) {
  return (
    <ActionBar label={label} count={count}>
      {items.map(item => (
        <Fragment key={item.key}>
          {item.divider && <span className="action-bar__spacer" />}
          {item.divider && detail && <span className="action-bar__detail">{detail}</span>}
          <Button kind={item.kind || undefined} icon={item.icon} tone={TONES[item.tone]} disabled={busy || item.disabled}
            title={item.title} onClick={() => onItem(item.key)}>{item.label}</Button>
        </Fragment>
      ))}
      {!items.some(item => item.divider) && detail && (
        <><span className="action-bar__spacer" /><span className="action-bar__detail">{detail}</span></>
      )}
    </ActionBar>
  );
}

// Right-click. Drawn on document.body so a window that is moved or scaled on the
// desktop cannot carry the menu away from the pointer, and kept inside the
// viewport so a file near the bottom edge does not open a menu nobody can reach.
function ContextMenu({ x, y, items, onItem, onClose }) {
  const box = useRef(null);
  const [spot, setSpot] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    setSpot({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
    const first = node.querySelector('button:not([disabled])');
    if (first) first.focus();
  }, [x, y]);

  useEffect(() => {
    const away = event => { if (box.current && !box.current.contains(event.target)) onClose(); };
    const keys = event => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !box.current) return;
      event.preventDefault();
      const buttons = Array.from(box.current.querySelectorAll('button:not([disabled])'));
      const at = buttons.indexOf(document.activeElement);
      const next = buttons[(at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
      if (next) next.focus();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', keys, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', keys, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div ref={box} className="context-menu" role="menu" style={spot} onContextMenu={event => event.preventDefault()}>
      {items.map(item => (
        <Fragment key={item.key}>
          {item.divider && <div className="context-menu__divider" role="separator" />}
          <button type="button" role="menuitem" disabled={item.disabled} title={item.title}
            data-danger={item.kind === 'danger'} onClick={() => onItem(item.key)}>
            <Icon name={item.icon} size={15} /><span>{item.label}</span>
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

// The list with details: name, type, size and date in columns that sort. Folders
// stay at the top whatever the order, as in every file manager people already use.
// Public adds each file's address with a copy button; Shared adds how many links a
// file has and a way to manage them — the addresses people asked to see.
const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'size', label: 'Size' },
  { key: 'added', label: 'Added' },
];
function FileList({
  listRef, place, folders, files, sort, onSort, tree, selectedIds, selectedFolderIds, draggingIds,
  onSelectFile, onOpenFile, onFileDrag, onFileDragEnd, onSelectFolder, onEnterFolder, onFolderDrag,
  onDropFiles, onDropFolder, onMenu, onItem,
}) {
  const extra = place === 'public' ? 'Address' : place === 'shared' ? 'Links' : place === 'trash' ? 'Deleted' : null;
  const [over, setOver] = useState(null);
  return (
    <div ref={listRef} className="file-list" role="grid" aria-label={`${PLACES[place].label} files`} data-extra={!!extra}>
      <div className="file-list__head" role="row">
        {COLUMNS.map(column => {
          const active = sort && sort.key === column.key;
          return (
            <div key={column.key} role="columnheader" className={`file-list__cell file-list__cell--${column.key}`}
              aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
              {sort ? (
                <button type="button" onClick={() => onSort(column.key)} data-active={active}>
                  {column.label}
                  {active && <span className="file-list__arrow" aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </button>
              ) : <span>{column.label}</span>}
            </div>
          );
        })}
        {extra && <div role="columnheader" className="file-list__cell file-list__cell--extra"><span>{extra}</span></div>}
      </div>

      {folders.map((folder, index) => (
        <div
          key={folder.id}
          role="row"
          tabIndex={0}
          draggable
          data-grid-card
          data-grid-index={index}
          data-kind="folder"
          data-id={folder.id}
          data-selected={selectedFolderIds.has(folder.id)}
          data-drop={over === folder.id}
          aria-selected={selectedFolderIds.has(folder.id)}
          className="file-row file-row--folder"
          onClick={event => onSelectFolder(folder, event)}
          onDoubleClick={() => onEnterFolder(folder)}
          onContextMenu={event => onMenu(event, 'folder', folder)}
          onDragStart={event => onFolderDrag(event, folder)}
          onDragOver={event => { if (!fromOutside(event)) { event.preventDefault(); setOver(folder.id); } }}
          onDragLeave={() => setOver(null)}
          onDrop={event => {
            event.preventDefault(); event.stopPropagation(); setOver(null);
            const ids = draggedFiles(event);
            if (ids.length) return onDropFiles(ids, folder.id);
            const moved = draggedFolders(event).filter(id => id !== folder.id);
            if (moved.length) onDropFolder(moved, folder.id);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); onEnterFolder(folder); }
            if (event.key === 'F2') { event.preventDefault(); onItem('renameFolder', folder); }
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) onMenu(event, 'folder', folder);
          }}
        >
          <div className="file-list__cell file-list__cell--name"><Icon name="folder" size={16} /><FileName name={folder.name} /></div>
          <div className="file-list__cell file-list__cell--type">Folder</div>
          <div className="file-list__cell file-list__cell--size">{folder.files ? `${folder.files} file${folder.files === 1 ? '' : 's'}` : '—'}</div>
          <div className="file-list__cell file-list__cell--added">{folder.created_at ? when(folder.created_at) : ''}</div>
          {extra && <div className="file-list__cell file-list__cell--extra" />}
        </div>
      ))}

      {files.map((file, index) => {
        const selected = selectedIds.has(file.id);
        return (
          <div
            key={file.id}
            role="row"
            tabIndex={0}
            draggable
            data-grid-card
            data-grid-index={folders.length + index}
            data-kind="file"
            data-id={file.id}
            data-selected={selected}
            data-dragging={draggingIds.has(file.id)}
            aria-selected={selected}
            aria-label={`${file.name}, ${typeOf(file.name)}, ${bytes(file.size)}, added ${when(file.added_at)}`}
            className="file-row"
            onClick={event => onSelectFile(file, event)}
            onDoubleClick={() => onOpenFile(file)}
            onContextMenu={event => onMenu(event, 'file', file)}
            onDragStart={event => onFileDrag(event, file)}
            onDragEnd={onFileDragEnd}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); onOpenFile(file); }
              if (event.key === 'F2' && file.place !== 'trash') { event.preventDefault(); onItem('rename', file); }
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) onMenu(event, 'file', file);
            }}
          >
            <div className="file-list__cell file-list__cell--name">
              <span className="file-row__mark" style={{ '--place': (PLACES[file.place] || PLACES.private).tone }}>{typeOf(file.name).slice(0, 4)}</span>
              <FileName name={file.name} />
            </div>
            <div className="file-list__cell file-list__cell--type">{typeOf(file.name)}</div>
            <div className="file-list__cell file-list__cell--size">{bytes(file.size)}</div>
            <div className="file-list__cell file-list__cell--added">{when(file.added_at)}</div>
            {place === 'public' && (
              <div className="file-list__cell file-list__cell--extra">
                {addressFor(file) && (
                  <>
                    <span className="file-row__address" title={addressFor(file)}>{addressFor(file).replace(/^https?:\/\//, '')}</span>
                    <Button kind="ghost" icon="copy" onClick={event => { event.stopPropagation(); onItem('copyAddress', file); }}>Copy</Button>
                  </>
                )}
              </div>
            )}
            {place === 'shared' && (
              <div className="file-list__cell file-list__cell--extra">
                <span>{file.shares ? `${file.shares} link${file.shares === 1 ? '' : 's'}` : 'No live links'}</span>
                <Button kind="ghost" icon="shared" onClick={event => { event.stopPropagation(); onItem('share', file); }}>Manage</Button>
              </div>
            )}
            {place === 'trash' && <div className="file-list__cell file-list__cell--extra">{when(file.deleted_at)}</div>}
          </div>
        );
      })}
    </div>
  );
}

function ActionBar({ label, count, children }) {
  return (
    <div className="action-bar" aria-label={`Actions for ${label}`}>
      <div className="action-bar__selection"><span>{count}</span><FileName name={label} /></div>
      <div className="action-bar__buttons">{children}</div>
    </div>
  );
}

function NameSheet({ title, eyebrow, action, initial = '', note, onClose, onDone }) {
  const [name, setName] = useState(initial);
  const done = () => { if (name.trim()) onDone(name.trim()); };
  return (
    <Sheet title={title} eyebrow={eyebrow} onClose={onClose}>
      <form onSubmit={event => { event.preventDefault(); done(); }}>
        <label className="field">
          <span className="field__label">Name</span>
          <input className="field__input" autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={120} placeholder="Invoices" />
        </label>
        {note ? <p className="sheet-copy">{note}</p> : null}
        <div className="sheet-actions"><Button kind="solid" type="submit" disabled={!name.trim()}>{action}</Button><Button type="button" onClick={onClose}>Not now</Button></div>
      </form>
    </Sheet>
  );
}

function MoveManySheet({ files, folders, tree, at, onClose, onDone }) {
  // A folder cannot be moved into itself or into anything inside it, so those
  // destinations are not offered. Without this the picker lists a place the box
  // will refuse, which is a menu item that exists to fail.
  const blocked = new Set(folders.flatMap(folder => [folder.id, ...descendants(tree, folder.id)]));
  const rows = [{ id: TOP, name: 'My Files', depth: 0 }, ...flatten(tree, TOP, 1).filter(row => !blocked.has(row.id))];
  const counted = [
    files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : null,
    folders.length ? `${folders.length} folder${folders.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' and ');
  const one = files.length + folders.length === 1;
  return (
    <Sheet
      title={one ? `Move ${files.length ? 'file' : 'folder'}` : `Move ${counted}`}
      eyebrow={one ? (files[0] || folders[0]).name : undefined}
      onClose={onClose}
    >
      <FolderPicker rows={rows} current={folders.length ? null : at} onPick={onDone} />
      <Button onClick={onClose}>Leave {one ? 'it' : 'them'} where {one ? 'it is' : 'they are'}</Button>
    </Sheet>
  );
}

// What the keyboard does, in one place, because a shortcut nobody can find is a
// shortcut nobody has.
function ShortcutSheet({ onClose }) {
  const keys = [
    ['Click, then shift-click', 'Select a run of things'],
    ['Cmd or Ctrl click', 'Add one thing to the selection'],
    ['Arrow keys', 'Move through the grid, taking the selection with you'],
    ['Shift and an arrow', 'Add what you land on to the selection'],
    ['Cmd or Ctrl and an arrow', 'Move without changing the selection'],
    ['Space', 'Add the thing under the cursor'],
    ['Cmd or Ctrl A', 'Select everything here, folders included'],
    ['Enter', 'Open a file, or go into a folder'],
    ['Delete or Backspace', 'Move the selected files to the Trash'],
    ['F2', 'Rename the selected folder'],
    ['Escape', 'Put the selection down'],
    ['?', 'This list'],
  ];
  return (
    <Sheet title="Keyboard" eyebrow="Everything the grid answers to" onClose={onClose}>
      <dl className="fact-list">
        {keys.map(([key, what]) => (
          <div className="fact-list__row" key={key}><dt>{key}</dt><dd>{what}</dd></div>
        ))}
      </dl>
    </Sheet>
  );
}

function MoveFolderSheet({ folder, tree, onClose, onDone }) {
  const blocked = new Set([folder.id, ...descendants(tree, folder.id)]);
  const rows = [{ id: TOP, name: 'My Files', depth: 0 }, ...flatten(tree, TOP, 1).filter(row => !blocked.has(row.id))];
  return (
    <Sheet title="Move folder" eyebrow={folder.name} onClose={onClose}>
      <FolderPicker rows={rows} current={folder.parent_id} onPick={onDone} />
      <Button onClick={onClose}>Leave it where it is</Button>
    </Sheet>
  );
}

function FolderPicker({ rows, current, onPick }) {
  return (
    <div className="folder-picker">
      {rows.map(row => (
        <button key={row.id} type="button" onClick={() => onPick(row.id)} disabled={row.id === current}
          style={{ '--folder-depth': row.depth }}>
          <Icon name="folder" size={16} /><span>{row.name}</span>{row.id === current ? <small>Here now</small> : null}
        </button>
      ))}
    </div>
  );
}

// Exported because the desktop needs the same question. A file dropped on
// Public asks it here rather than publishing on the strength of a gesture.
export function PublishSheet({ files, onClose, onPublish }) {
  const [found, setFound] = useState(null);
  const [removeCamera, setRemoveCamera] = useState(true);
  const [removePacket, setRemovePacket] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    // Whether there is anything to remove is the server's answer, read out of
    // the bytes. The row's mime is whatever the uploading client declared, and
    // a photograph does not stop carrying GPS because a client said octet-stream.
    Promise.all(files.map(async file => {
      const metadata = await api.metadata(file.id);
      return {
        id: file.id,
        camera: !!metadata.exif,
        cameraLocation: Number.isFinite(metadata.exif?.gps_lat) && Number.isFinite(metadata.exif?.gps_lon),
        packet: metadata.xmp || null,
      };
    })).then(rows => {
      if (!active) return;
      setFound(rows);
      // A packet holding coordinates starts ticked; one holding somebody's
      // credit does not. Neither default is a decision made for them — the
      // original is kept either way — but the one that starts ticked is the
      // one where leaving it alone is the answer nobody would have chosen.
      setRemovePacket(rows.some(row => row.packet && row.packet.location));
    }).catch(() => { if (active) setError('Could not check what these files say about themselves. Reopen this sheet to try again.'); });
    return () => { active = false; };
  }, [files]);

  const from = files.every(file => file.place === 'shared') ? 'shared' : 'private';
  const withCamera = (found || []).filter(row => row.camera);
  const withPacket = (found || []).filter(row => row.packet);
  const packetLocation = withPacket.some(row => row.packet.location);
  const packetCredit = withPacket.some(row => row.packet.credit);
  const packetUnreadable = withPacket.some(row => !row.packet.readable);
  // One question, asked of every carrier rather than of one format: does this
  // say where the person was standing. What removes it is two separate answers,
  // because the two carriers cost different things to lose.
  const saysWhere = (found || []).some(row => row.cameraLocation || (row.packet && row.packet.location));
  const locationSurvives = withPacket.some(row => row.packet.location) && !removePacket;

  return (
    <Sheet title={files.length === 1 ? 'Put this on the open internet?' : `Publish ${files.length} files?`} eyebrow={files.length === 1 ? files[0].name : undefined} onClose={onClose} tone={PLACES.public.tone}>
      <StateCrossing from={from} to="public" />
      <h3 className="sheet-question">Anyone with the address can open {files.length === 1 ? 'it' : 'them'} without signing in.</h3>
      <p className="sheet-copy">Each file gets its own address. You can take it off the internet later and that address will stop working. Existing share links, if any, keep their own role and expiry.</p>
      {saysWhere && (
        <p className="sheet-copy"><strong>{files.length === 1 ? 'This file says where it was taken.' : 'These files say where they were taken.'}</strong>{' '}
          That travels with any copy, including a published one.</p>
      )}
      {withCamera.length > 0 && (
        <label className="sheet-copy">
          <input type="checkbox" checked={removeCamera} onChange={event => setRemoveCamera(event.target.checked)} />
          {' '}Remove camera metadata, including GPS. Keep the original in version history.
        </label>
      )}
      {withPacket.length > 0 && (
        <label className="sheet-copy">
          <input type="checkbox" checked={removePacket} onChange={event => setRemovePacket(event.target.checked)} />
          {' '}Remove the editing and rights information (XMP).{' '}
          {packetLocation && 'This one names a location as well. '}
          {packetCredit && 'It also holds a credit or licence line, which goes with it. '}
          {packetUnreadable && 'It is compressed, so what it says cannot be read from here. '}
          {!packetLocation && !packetCredit && !packetUnreadable && 'Usually editing history. '}
          The original is kept in version history.
        </label>
      )}
      {locationSurvives && (
        <p className="sheet-copy" role="status">
          Left as it is, the location in that packet will be published with the file.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="sheet-actions">
        <Button kind="solid" tone={PLACES.public.tone} icon="publish" disabled={found === null}
          onClick={() => onPublish({
            exif: removeCamera ? withCamera.map(row => row.id) : [],
            xmp: removePacket ? withPacket.map(row => row.id) : [],
          })}>Publish {files.length === 1 ? 'it' : 'them'}</Button>
        <Button onClick={onClose}>Keep {files.length === 1 ? 'it' : 'them'} as {from === 'shared' ? 'Shared' : 'My Files'}</Button>
      </div>
    </Sheet>
  );
}

function flatten(tree, parent, depth) {
  return tree.filter(folder => folder.parent_id === parent)
    .flatMap(folder => [{ id: folder.id, name: folder.name, depth }, ...flatten(tree, folder.id, depth + 1)]);
}

function descendants(tree, id) {
  return tree.filter(folder => folder.parent_id === id).flatMap(folder => [folder.id, ...descendants(tree, folder.id)]);
}

function Empty({ place, counts, inFolder, onAdd }) {
  const elsewhere = (counts.shared || 0) + (counts.public || 0);
  const copy = {
    private: inFolder
      ? ['This folder is empty', 'Drop files here, or move them here from anywhere else.']
      : elsewhere
        ? ['Nothing private at the moment', `Your ${elsewhere} other file${elsewhere === 1 ? ' is' : 's are'} in Shared or Public. Stop every link or take a file off the internet and it returns here.`]
        : ['Nothing here yet', 'Drop files anywhere on this window, or add them.'],
    shared: ['You have not given anybody a link', 'Add a file here and you will be asked who gets a link, or choose one in My Files.'],
    public: ['Nothing is on the internet', 'Add a file here and you will be asked whether to publish it. Nothing goes on the internet by itself.'],
    trash: ['Trash is empty', 'Deleted files wait here before they go for good.'],
  }[place];
  return (
    <div className="empty-state" style={{ '--place': PLACES[place].tone, '--place-soft': PLACES[place].wash }}>
      <span className="empty-state__icon"><Icon name={PLACES[place].icon} size={25} /></span>
      <h2>{copy[0]}</h2><p>{copy[1]}</p>
      {onAdd && <Button kind="solid" icon="add" onClick={onAdd}>Add files</Button>}
    </div>
  );
}
