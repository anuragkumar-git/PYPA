/**
 * Images come out of extractPaper() as Blobs, which IndexedDB can store directly (no base64 bloat).
 * Use these helpers only if you need plain JSON (export / backup / sending somewhere).
 */
export const blobToDataURL = (blob) =>
  new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(blob); });

export const dataURLToBlob = async (url) => (await fetch(url)).blob();

const mapImg = async (img, fn) => (img ? { ...img, blob: undefined, ...(await fn(img)) } : null);

/** paper (with Blobs) → JSON-safe object (images as data URLs) */
export async function paperToJSON(paper) {
  const enc = async (img) => ({ dataUrl: await blobToDataURL(img.blob), width: img.width, height: img.height, scale: img.scale });
  return {
    ...paper,
    questions: await Promise.all(paper.questions.map(async (q) => ({
      ...q,
      images: await Promise.all(q.images.map((i) => mapImg(i, enc))),
      options: await Promise.all(q.options.map(async (o) => ({ ...o, image: await mapImg(o.image, enc) }))),
    }))),
  };
}

/** inverse of paperToJSON */
export async function paperFromJSON(json) {
  const dec = async (img) => ({ blob: await dataURLToBlob(img.dataUrl), width: img.width, height: img.height, scale: img.scale });
  return {
    ...json,
    questions: await Promise.all(json.questions.map(async (q) => ({
      ...q,
      images: await Promise.all(q.images.map((i) => dec(i))),
      options: await Promise.all(q.options.map(async (o) => ({ ...o, image: o.image ? await dec(o.image) : null }))),
    }))),
  };
}
