// Image helpers: resize, convert, base64, aspect ratio.

export function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image. Try a JPG or PNG.')); };
    img.src = url;
  });
}

// Resize so the longest side is <= max, re-encode as JPEG.
export async function normalize(blob, max = 2048, quality = 0.92) {
  const { img, url } = await loadImage(blob);
  try {
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, max / Math.max(w, h));
    const cw = Math.round(w * s), ch = Math.round(h * s);
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cw, ch);
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
    return { blob: out, w: cw, h: ch };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export function b64ToBlob(b64, type = 'image/png') {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
export function nearestAspect(w, h) {
  if (!w || !h) return null;
  const target = Math.log(w / h);
  let best = RATIOS[0], bestD = Infinity;
  for (const r of RATIOS) {
    const [a, b] = r.split(':').map(Number);
    const d = Math.abs(Math.log(a / b) - target);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}
