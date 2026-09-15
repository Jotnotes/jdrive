// Local decoders only. The archive reader has no worker or compression engine:
// listing a ZIP reads its directory, never its file contents. Office decoders
// receive bytes already fetched with the session, never a URL.
import { ZipReader, Uint8ArrayReader } from '@zip.js/zip.js/lib/zip-core-custom.js';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

export const MAX_OFFICE = 20 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_ROWS = 1000;
const MAX_COLUMNS = 100;

export async function decodeOffice(kind, buffer) {
  if (buffer.byteLength > MAX_OFFICE) throw new Error('Preview budget exceeded');
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(buffer)), { useWebWorkers: false });
  const entries = [];
  let expanded = 0;
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (entries.length >= MAX_ENTRIES) throw new Error('Too many entries to preview');
      entries.push({ name: entry.filename, size: entry.uncompressedSize, directory: entry.directory });
      expanded += entry.uncompressedSize;
      // A small compressed document can still expand beyond what a tab can hold.
      // ZIP listings do not expand anything and need no expanded-size budget.
      if (kind !== 'zip' && (entry.encrypted || expanded > MAX_EXPANDED)) throw new Error('Document cannot be previewed');
    }
  } finally {
    await reader.close();
  }
  if (kind === 'zip') return { kind, entries };
  if (kind === 'docx') {
    // Raw text intentionally discards links, images and HTML. React escapes it
    // on display; source markup never reaches the signed-in page as markup.
    const result = await mammoth.extractRawText({ arrayBuffer: buffer }, { externalFileAccess: false });
    return { kind, paragraphs: result.value.split(/\n\n/).filter(Boolean) };
  }
  // The browser build reads the supplied bytes without workers, fonts or URLs.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('No sheet to preview');
  const columns = Math.min(MAX_COLUMNS, sheet.columnCount);
  const rows = Array.from({ length: Math.min(MAX_ROWS, sheet.rowCount) }, (_, row) =>
    Array.from({ length: columns }, (_, column) => cellText(sheet.getCell(row + 1, column + 1).value)));
  return { kind: 'xlsx', sheet: sheet.name, columns, rows,
    truncated: sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS };
}

function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value);
  // Display cached formula results, never evaluate formulas or follow links.
  if ('formula' in value || 'sharedFormula' in value) return cellText(value.result);
  if (value.richText) return value.richText.map(part => part.text).join('');
  if (value.text != null) return String(value.text);
  if (value.error) return String(value.error);
  return '';
}
