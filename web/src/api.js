// Everything this shell knows how to ask the box.
//
// The token lives in memory and in localStorage. It is a bearer token, so it is
// worth being plain about the trade: anything that can run script on this origin
// can read it. Nothing here renders anybody's file as HTML on this origin — a
// published file is served from the box with its own sandbox headers, and a
// preview is drawn into an <img> — so there is no route by which somebody else's
// content becomes script here.

const KEY = 'files.session';
// Where an actor's own token waits while they are signed in as somebody else.
//
// One token is live at a time — `KEY` — because two live sessions in one browser
// is how somebody acts as themselves in one tab and as their customer in the
// next, with the banner telling the truth in only one of them. But the actor's
// own session is not ended by borrowing another, and making them sign in again
// after every support call is how a feature stops being used. So it is set
// aside here, unused, and swapped back when the borrowed one ends. Nothing is
// exposed that was not already in this browser a moment earlier.
const OWN = 'files.session.own';

export const session = {
  get token() {
    try { return localStorage.getItem(KEY) || null; } catch { return null; }
  },
  set(token) {
    try { token ? localStorage.setItem(KEY, token) : localStorage.removeItem(KEY); } catch { /* private window */ }
  },
  // Step aside for a borrowed session, and come back afterwards.
  standAside(borrowedToken) {
    try {
      const own = localStorage.getItem(KEY);
      if (own) localStorage.setItem(OWN, own);
      localStorage.setItem(KEY, borrowedToken);
    } catch { /* private window: the borrowed session simply replaces it */ }
  },
  // Returns false when there is nothing to come back to — a browser that cleared
  // its storage, or a session begun in another tab — and the caller signs in
  // again rather than being left holding a token that no longer works.
  resume() {
    try {
      const own = localStorage.getItem(OWN);
      if (!own) { localStorage.removeItem(KEY); return false; }
      localStorage.setItem(KEY, own);
      localStorage.removeItem(OWN);
      return true;
    } catch { return false; }
  },
};

let onSignedOut = () => {};
export const whenSignedOut = fn => { onSignedOut = fn; };

export async function call(path, { method = 'GET', body, form, bytes, headers = {}, raw = false } = {}) {
  const token = session.token;
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (form) init.body = form;
  else if (bytes) { init.body = bytes; init.headers['Content-Type'] = bytes.type || 'application/octet-stream'; }
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    // The token is gone, revoked or from a box that has been restored. Ending
    // the session here rather than showing a broken screen is the difference
    // between "sign in again" and "this product is broken".
    session.set(null);
    onSignedOut();
  }
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const error = new Error((json && json.error) || text || `Request failed (${res.status})`);
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return json;
}

export const api = {
  signIn: (email, password) => call('/api/login', { method: 'POST', body: { email, password } }),
  signOut: () => call('/api/logout', { method: 'POST' }),
  me: () => call('/api/me'),
  // What this box is: version, the commit it was cut from, and where its
  // database sits against the migrations this build knows. Seller-only, and
  // deliberately not baked into this bundle — the product's own name is on the
  // wrong side of the white-label guard, so it is said by the box or not at all.
  box: () => call('/api/box'),
  usage: () => call('/api/usage'),

  requestReset: email => call('/api/password-reset', { method: 'POST', body: { email } }),
  confirmReset: (token, password) => call('/api/password-reset/confirm', { method: 'POST', body: { token, password } }),
  confirmAddress: token => call('/api/verify-email', { method: 'POST', body: { token } }),
  resendConfirmation: email => call('/api/verify-email/resend', { method: 'POST', body: { email } }),

  // Whose product this is. Reading it needs no session at all — the sign-in
  // screen and a shared link both have to know whose name is on them before
  // anybody has signed in. Writing it is the Hosting edition's.
  brand: () => call('/api/brand'),

  // The commercial side. Every one of these is refused to an account that does
  // not outrank an end user, by the box rather than by this file.
  accounts: () => call('/api/accounts'),
  metrics: () => call('/api/metrics'),
  createAccount: body => call('/api/accounts', { method: 'POST', body }),
  // Named for what they act on. `restore` already means taking a file out of the
  // Trash further down this object, and an account restore called the same thing
  // was quietly overwritten by it — the console suspended somebody and then
  // asked the files route to bring them back.
  // Suspension names one account and stops that one. Nothing carries down, and
  // there is no argument here that would make it: a reseller who stops paying is
  // answered by taking their customers over, not by stopping customers who did
  // nothing wrong.
  suspendAccount: id => call(`/api/accounts/${id}/suspend`, { method: 'POST' }),
  restoreAccount: id => call(`/api/accounts/${id}/restore`, { method: 'POST' }),
  entitlements: id => call(`/api/accounts/${id}/entitlements`),
  reconcile: id => call(`/api/accounts/${id}/storage/reconcile`),
  // What happened to an account. The box narrows this to the account record; a
  // customer's own file history never leaves their own session.
  accountTrail: (id, before) => call(`/api/accounts/${id}/audit${before ? `?before=${before}` : ''}`),
  editAccount: (id, body) => call(`/api/accounts/${id}/edit`, { method: 'POST', body }),
  startPasswordReset: id => call(`/api/accounts/${id}/password-reset`, { method: 'POST' }),
  // Named apart from `resendConfirmation` above on purpose. That one is the
  // self-serve route, anonymous and keyed by address, and it answers the same
  // way whatever it is given. This one is the console's, keyed by account and
  // allowed to say whether the message went. One name for both would have
  // silently replaced the sign-in screen's resend with a call it cannot make.
  resendConfirmationFor: id => call(`/api/accounts/${id}/verify-email/resend`, { method: 'POST' }),
  setLimit: (id, metric, body) => call(`/api/accounts/${id}/limits/${metric}`, { method: 'PUT', body }),
  clearLimit: (id, metric) => call(`/api/accounts/${id}/limits/${metric}`, { method: 'DELETE' }),
  // Terminating and its archive. The confirmation words are sent from here
  // because the box asks for them: a mis-click is one request away otherwise,
  // and this is the pair of actions that cannot be undone by pressing the other
  // button.
  terminateAccount: (id, keepDays) => call(`/api/accounts/${id}/terminate`,
    { method: 'POST', body: { confirm: 'terminate', ...(keepDays ? { keepDays } : {}) } }),
  archives: () => call('/api/archives'),
  verifyArchive: id => call(`/api/archives/${id}/verify`, { method: 'POST' }),
  restoreArchive: id => call(`/api/archives/${id}/restore`, { method: 'POST' }),
  destroyArchive: id => call(`/api/archives/${id}`, { method: 'DELETE', body: { confirm: 'delete for ever' } }),

  files: () => call('/api/files'),
  // Finding something by name — a file's, the folder it is in, or a word its
  // owner put on it. Across every place at once, because a search that only
  // looked where you happen to be standing would be a filter with a longer name.
  // The Trash is left out unless it is asked for: a deleted file among live
  // results is an invitation to work on something that is being swept.
  search: (q, { includeTrash = false } = {}) =>
    call(`/api/search?q=${encodeURIComponent(q)}${includeTrash ? '&include_trash=1' : ''}`),
  upload: (files, onProgress, folder) => uploadWithProgress(files, onProgress, folder),
  download: id => call(`/api/files/${id}/download`, { raw: true }),
  publish: (id, remove = {}) => call(`/api/files/${id}/public`, { method: 'POST', body: { stripExif: !!remove.exif, stripXmp: !!remove.xmp } }),
  unpublish: id => call(`/api/files/${id}/private`, { method: 'POST' }),
  trash: id => call(`/api/files/${id}`, { method: 'DELETE' }),
  restore: id => call(`/api/files/${id}/restore`, { method: 'POST' }),
  emptyTrash: () => call('/api/files/trash/empty', { method: 'POST' }),

  folders: () => call('/api/folders'),
  newFolder: (name, parent) => call('/api/folders', { method: 'POST', body: { name, parent: parent || 'root' } }),
  renameFolder: (id, name) => call(`/api/folders/${id}/rename`, { method: 'POST', body: { name } }),
  moveFolder: (id, parent) => call(`/api/folders/${id}/move`, { method: 'POST', body: { parent: parent || 'root' } }),
  removeFolder: id => call(`/api/folders/${id}`, { method: 'DELETE' }),
  fileInto: (id, folder) => call(`/api/files/${id}/folder`, { method: 'POST', body: { folder: folder || 'root' } }),
  renameFile: (id, name) => call(`/api/files/${id}/rename`, { method: 'POST', body: { name } }),

  // What the file says about itself, and the words its owner put on it. Both
  // are core and neither is AI: the first is read out of the file's own bytes,
  // the second is typed by the person who owns it.
  metadata: id => call(`/api/files/${id}/metadata`),

  // What a file used to be. Customer recovery: the same idea as the Trash, one
  // level in — the Trash is a file you deleted, this is a file you saved over.
  versions: id => call(`/api/files/${id}/versions`),
  replaceFile: (id, file, onProgress) => replaceWithProgress(id, file, onProgress),
  restoreVersion: (id, versionId) => call(`/api/files/${id}/versions/${versionId}/restore`, { method: 'POST' }),
  downloadVersion: (id, versionId) => call(`/api/files/${id}/versions/${versionId}/download`, { raw: true }),
  tags: () => call('/api/tags'),
  tagFile: (id, name) => call(`/api/files/${id}/tags`, { method: 'POST', body: { name } }),
  untagFile: (id, tagId) => call(`/api/files/${id}/tags/${tagId}`, { method: 'DELETE' }),
  retireTag: id => call(`/api/tags/${id}`, { method: 'DELETE' }),

  thumbnail: id => call(`/api/files/${id}/thumbnail`, { raw: true }),
  putThumbnail: (id, blob, w, h) => call(`/api/files/${id}/thumbnail?w=${w}&h=${h}`, { method: 'PUT', bytes: blob }),

  shares: id => call(`/api/files/${id}/shares`),
  share: (id, opts) => call(`/api/files/${id}/share`, { method: 'POST', body: opts }),
  unshare: id => call(`/api/files/${id}/unshare`, { method: 'POST' }),
};

// Saving over a file. The same transport as an upload, because it is one — what
// differs is that the box keeps what was there rather than dropping it.
function replaceWithProgress(id, file, onProgress) {
  return sendMultipart(`/api/files/${id}/replace`, [file], onProgress);
}

// XHR rather than fetch, for one reason: a person uploading a two-gigabyte file
// needs to see it moving. fetch cannot report upload progress.
function uploadWithProgress(files, onProgress, folder) {
  // Where the person is standing when they drop something. The box checks it is
  // theirs before believing it.
  return sendMultipart('/api/files', files, onProgress, folder);
}

// One transport, used by the upload and by saving over a file, so the two cannot
// drift apart on how they report progress or how they read a refusal.
function sendMultipart(url, files, onProgress, folder) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    if (folder && folder !== 'root') form.append('folder', folder);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    const token = session.token;
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
      if (xhr.status === 401) { session.set(null); onSignedOut(); }
      const error = new Error((body && body.error) || `That did not go through (${xhr.status}).`);
      error.status = xhr.status;
      reject(error);
    };
    xhr.onerror = () => reject(new Error('That did not reach the box.'));
    xhr.send(form);
  });
}

// Saving a file to the machine. The bytes need the token, so this cannot be a
// plain link: it is a fetch, then an anchor pointed at what came back, then the
// object URL let go a few seconds later.
export async function saveFile(file) {
  const res = await api.download(file.id);
  if (!res.ok) throw new Error('That file could not be downloaded.');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// A preview needs the bytes, and the bytes need the token, so an <img src> to
// the download route would just 401. Fetched once and held as an object URL,
// and revoked when the card goes away.
export async function previewUrl(id) {
  const res = await api.download(id);
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}
