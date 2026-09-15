// What the files window decides, kept apart from how it draws.
//
// Every rule here used to live inside a component, where the only way to prove it
// was to click it — and the browser walk on 2026-09-13 found four of them wrong or
// missing by clicking. Pulled out, the same function answers the action bar and the
// right-click menu, so the two can never offer different things, and the audit can
// call it directly instead of trusting a screenshot.
//
// No imports and no DOM: the audit loads this file in Node.

export const TOP = 'root';

export const SORT_KEYS = ['name', 'type', 'size', 'added'];

export const PLAN_METRICS = {
  publicFiles: 'files_public',
  shareLinks: 'files_share_links',
};

// The customer-facing entitlements route returns every metric this box carries.
// No row means the capability has not been priced and is therefore on, matching
// the server. A row with no assignment, zero or an unusable value is off.
export function planCapabilities(metrics) {
  const allows = key => {
    const row = (metrics || []).find(metric => metric && metric.metric === key);
    if (!row) return true;
    if (row.missing_assignment) return false;
    if (row.maximum_allowed && row.maximum_allowed.unlimited) return true;
    const value = Number(row.maximum_allowed && row.maximum_allowed.value);
    return Number.isFinite(value) && value > 0;
  };
  return {
    publicFiles: allows(PLAN_METRICS.publicFiles),
    shareLinks: allows(PLAN_METRICS.shareLinks),
  };
}

// One plain sentence for the space where an unavailable action would otherwise
// sit. The caller supplies the hosting company's support label, or the neutral
// fallback when the brand has not configured one.
export function planNotice({ shareLinks = true, publicFiles = true } = {}, contact = 'your provider') {
  const absent = [
    shareLinks ? null : 'Share links',
    publicFiles ? null : 'publishing files',
  ].filter(Boolean);
  if (!absent.length) return null;
  const subject = absent.length === 2 ? `${absent[0]} and ${absent[1]}` : absent[0];
  const verb = absent.length === 2 || absent[0] === 'Share links' ? 'are' : 'is';
  return `${subject} ${verb} not included in your plan; ask ${contact || 'your provider'} about changing it.`;
}

// The type a person reads off a filename. Not the MIME type: "PNG" is what they
// call it, and a file with no extension is honestly "File".
export function typeOf(name) {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(String(name || ''));
  return match ? match[1].toUpperCase() : 'File';
}

const collator = typeof Intl !== 'undefined'
  ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  : { compare: (a, b) => String(a).localeCompare(String(b)) };

// Sorted copies, never in place, so the list a component holds is not reordered
// underneath it. Ties fall back to the name, so two files of the same size keep a
// stable, readable order instead of shuffling on every render. "File 2" comes
// before "File 10", which is what a person means by alphabetical.
export function sortEntries(list, { key = 'name', dir = 'asc' } = {}) {
  const sign = dir === 'desc' ? -1 : 1;
  const byName = (a, b) => collator.compare(a.name || '', b.name || '');
  const measure = {
    name: () => 0,
    type: (a, b) => collator.compare(typeOf(a.name), typeOf(b.name)),
    size: (a, b) => (Number(a.size) || 0) - (Number(b.size) || 0),
    added: (a, b) => String(a.added_at || '').localeCompare(String(b.added_at || '')),
  }[SORT_KEYS.includes(key) ? key : 'name'];
  // Ties keep A to Z whichever way the column runs: flipping a size sort should
  // not also flip the names of the files that are the same size.
  if (key === 'name' || !SORT_KEYS.includes(key)) return [...(list || [])].sort((a, b) => byName(a, b) * sign);
  return [...(list || [])].sort((a, b) => (measure(a, b) * sign) || byName(a, b));
}

// Clicking the column already sorted by turns it round; clicking another starts it
// the way people expect for that column: names A to Z, sizes and dates largest and
// newest first.
export function nextSort(current, key) {
  if (current && current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'size' || key === 'added' ? 'desc' : 'asc' };
}

// Whether Add files belongs in a place at all. Nothing is uploaded into the Trash.
export function canAddFilesIn(place) {
  return place === 'private' || place === 'public' || place === 'shared';
}

// What happens after an upload made from inside a place. A file always arrives
// private — nothing reaches the internet without being asked — so a file added in
// Public is offered publishing straight away, and one added in Shared is offered a
// link. Before this, both said "uploaded" and then showed an empty window, because
// the file had quietly gone to My Files.
export function afterUpload(place) {
  if (place === 'public') return 'publish';
  if (place === 'shared') return 'share';
  return null;
}

// One level up. A folder whose parent has gone reads as sitting at the top rather
// than stranding somebody in a place with no way out.
export function parentOf(tree, at) {
  if (!at || at === TOP) return TOP;
  const here = (tree || []).find(folder => folder.id === at);
  if (!here || !here.parent_id) return TOP;
  return (tree || []).some(folder => folder.id === here.parent_id) ? here.parent_id : TOP;
}

// The address a file can be copied from, when it has one anybody can open.
export function addressFor(file) {
  return file && file.place === 'public' && file.public_url ? file.public_url : null;
}

// Everything that can be done to one file, in order. The action bar and the
// right-click menu both draw this list, so they cannot disagree. `divider` marks
// where the destructive end of the list starts.
export function fileMenu(file, { borrowed = false, canFile = false, canShare = true, canPublish = true } = {}) {
  if (!file) return [];
  if (file.place === 'trash') return [{ key: 'restore', label: 'Restore', icon: 'restore', kind: 'solid' }];
  const items = [
    { key: 'open', label: 'Open', icon: 'open' },
  ];
  if (!borrowed) items.push({ key: 'download', label: 'Download', icon: 'download' });
  items.push({ key: 'details', label: file.versions ? `Details · ${file.versions}` : 'Details', icon: 'info' });
  items.push({ key: 'rename', label: 'Rename', icon: 'rename' });
  items.push({ key: 'replace', label: 'Replace…', icon: 'upload' });
  if (file.place !== 'public' && !borrowed && canShare) items.push({ key: 'share', label: 'Give a link', icon: 'shared', tone: 'shared' });
  if (canFile) items.push({ key: 'move', label: 'Move to…', icon: 'move' });
  if (file.place === 'public') {
    items.push({ key: 'unpublish', label: 'Take off internet', icon: 'unpublish' });
    if (file.public_url) items.push({ key: 'copyAddress', label: 'Copy address', icon: 'copy' });
  } else if (!borrowed && canPublish) {
    items.push({ key: 'publish', label: 'Publish', icon: 'publish', tone: 'public' });
  }
  // A public file is not trashed while it is public — the box refuses, so the
  // address cannot go on serving a deleted file. It used to be a greyed-out button
  // whose reason only showed on hover, and a person on a live box could not work
  // out how to delete it. Now it asks once, then takes it down and trashes it.
  items.push({
    key: 'trash', label: 'Move to Trash', icon: 'trash', kind: 'danger', divider: true,
    confirm: file.place === 'public' ? 'takeDown' : undefined,
  });
  return items;
}

export function folderMenu(folder, { childFolders = 0 } = {}) {
  if (!folder) return [];
  const full = (Number(folder.files) || 0) + (Number(childFolders) || 0);
  return [
    { key: 'enter', label: 'Open', icon: 'open', kind: 'solid' },
    { key: 'renameFolder', label: 'Rename', icon: 'rename' },
    { key: 'moveFolder', label: 'Move to…', icon: 'move' },
    { key: 'deleteFolder', label: 'Delete folder', icon: 'trash', kind: 'danger', divider: true,
      disabled: full > 0, title: full > 0 ? 'Empty it before it can go' : undefined },
  ];
}

// Several things at once.
export function bulkMenu({ place, files = 0, folders = 0, canFile = false, canPublish = true } = {}) {
  if (place === 'trash') return [{ key: 'restoreAll', label: 'Restore all', icon: 'restore', kind: 'solid' }];
  const items = [];
  if (place === 'private' && canFile) items.push({ key: 'moveMany', label: 'Move to…', icon: 'move' });
  if (place === 'shared') items.push({ key: 'unshareAll', label: 'Stop all links', icon: 'unpublish' });
  if (files > 0) {
    if (place === 'public' || canPublish) items.push(place === 'public'
      ? { key: 'unpublishAll', label: 'Take off internet', icon: 'unpublish' }
      : { key: 'publishAll', label: 'Publish all', icon: 'publish', tone: 'public' });
  }
  items.push({ key: 'trashAll', label: 'Move to Trash', icon: 'trash', kind: 'danger', divider: true,
    disabled: files === 0, confirm: place === 'public' ? 'takeDown' : undefined });
  return items;
}
