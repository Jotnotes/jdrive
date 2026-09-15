// A picture of a file.
//
// The box does not decode images, deliberately: an image decoder is the piece of
// software most likely to be broken by a file somebody uploaded, and this product
// has no reason to run one. So the browser — which is already decoding the
// picture to show it to the person who owns it — makes the small version, and the
// box stores the bytes it is handed.
//
// Made once, on the first view, and then it is the box's. Every later view of
// that file, on any machine, is one small request instead of a whole photograph.

import { api } from './api.js';

const LONGEST_SIDE = 512;
const QUALITY = 0.72;
// Past this, making a thumbnail costs more than the picture it saves. The card
// falls back to naming the file type, which is honest and cheap.
const TOO_BIG_TO_BOTHER = 25 * 1024 * 1024;

const cache = new Map();
const making = new Map();

export const canPicture = file => /^image\/(png|jpeg|webp|gif|bmp|avif)$/.test(file.mime || '');

// Called when files are gone for good. The pictures are held for as long as the
// desktop is open, which is what makes scrolling back cheap; they are only worth
// throwing away when the files behind them no longer exist.
export function forgetAll() {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
}

export async function thumbnailFor(file) {
  if (cache.has(file.id)) return cache.get(file.id);
  if (making.has(file.id)) return making.get(file.id);
  const work = (async () => {
    try {
      // Already made, and made once for everybody: this is the cheap path and
      // the one almost every view takes.
      if (file.thumbnail) {
        const res = await api.thumbnail(file.id);
        if (res.ok) {
          const url = URL.createObjectURL(await res.blob());
          cache.set(file.id, url);
          return url;
        }
      }
      if (!canPicture(file) || (file.size || 0) > TOO_BIG_TO_BOTHER) return null;
      const original = await api.download(file.id);
      if (!original.ok) return null;
      const blob = await original.blob();
      const small = await shrink(blob);
      if (!small) return null;
      // Handed to the box so nobody has to do this again. A failure here costs
      // nothing that matters: the picture is already on screen.
      api.putThumbnail(file.id, small.blob, small.w, small.h).catch(() => {});
      const url = URL.createObjectURL(small.blob);
      cache.set(file.id, url);
      return url;
    } catch {
      return null;
    } finally {
      making.delete(file.id);
    }
  })();
  making.set(file.id, work);
  return work;
}

async function shrink(blob) {
  if (typeof createImageBitmap !== 'function') return null;
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close && bitmap.close();
  const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  return out ? { blob: out, w, h } : null;
}
