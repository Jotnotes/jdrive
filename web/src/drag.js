// The wire format of a drag, in one place.
//
// A drag inside this product carries ids, not bytes: a list of file ids under
// one type and a list of folder ids under another. Both the Files window and
// the desktop read them, so the format lives here rather than in whichever file
// happened to need it first.
//
// One browser rule shapes everything below: during `dragover` the payload is
// not readable, only its types are. So the decision to accept a drag is made
// from `types`, and the decision what to do with it is made on `drop`.

export const FILE_DRAG = 'application/x-files';
export const FOLDER_DRAG = 'application/x-folder';

const types = event => Array.from(event.dataTransfer.types || []);

// Files coming from the operating system: a Finder window, a mail attachment.
export const fromOutside = event => types(event).includes('Files');

// Something from inside the product, still in flight.
export const carriesFiles = event => types(event).includes(FILE_DRAG);
export const carriesFolders = event => types(event).includes(FOLDER_DRAG);
export const carriesOurs = event => carriesFiles(event) || carriesFolders(event);

export const draggedFiles = event => carried(event, FILE_DRAG);
// Folders travel as a list for the same reason files do: a selection is usually
// more than one thing, and a single id was a shape that only worked while
// folders could only be selected one at a time.
export const draggedFolders = event => carried(event, FOLDER_DRAG);

function carried(event, type) {
  const raw = event.dataTransfer.getData(type);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return [raw]; }
}
