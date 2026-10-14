// Photos and barcodes. Barcode reading uses the browser's built-in BarcodeDetector
// (Chrome on Android has it); without it, photos still work through AI or typing.

import { toIsbn13 } from './catalog.js';

export const canDetectBarcodes = () => 'BarcodeDetector' in window;
export const canScanLive = () => canDetectBarcodes() && !!navigator.mediaDevices?.getUserMedia;

let detectorPromise;
function detector() {
  detectorPromise ??= (async () => {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const wanted = ['ean_13', 'isbn', 'upc_a'].filter((f) => supported.includes(f));
    return new window.BarcodeDetector(wanted.length ? { formats: wanted } : undefined);
  })();
  return detectorPromise;
}

// source: <video>, ImageBitmap, canvas... Returns an ISBN-13 or null.
export async function findIsbn(source) {
  if (!canDetectBarcodes()) return null;
  try {
    for (const code of await (await detector()).detect(source)) {
      const isbn = toIsbn13(code.rawValue);
      if (isbn) return isbn;
    }
  } catch {
    // Frame not ready or unsupported source: treat as "nothing found".
  }
  return null;
}

function toCanvas(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// A camera photo -> { bitmap (full size, for barcodes), base64 (1280px JPEG, for AI),
// thumb (small data URL, kept as the cover when no online cover exists) }.
export async function preparePhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const base64 = toCanvas(bitmap, 1280).toDataURL('image/jpeg', 0.85).split(',')[1];
  const thumb = toCanvas(bitmap, 320).toDataURL('image/jpeg', 0.75);
  return { bitmap, base64, thumb };
}

// A photo for a note: about 1024px (roughly 100-200 KB, small enough to sync through the
// Google Sheet) plus a 240px thumbnail for lists.
export async function notePhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  return { data: toCanvas(bitmap, 1024).toDataURL('image/jpeg', 0.7), thumb: toCanvas(bitmap, 240).toDataURL('image/jpeg', 0.6) };
}

// Opens the phone camera (or the gallery) and resolves with the chosen file, or null.
export function pickPhoto({ camera = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (camera) input.capture = 'environment';
    input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}
