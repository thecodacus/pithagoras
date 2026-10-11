import { api } from "./api";

/**
 * The small copies of the gallery's pictures. The portal has no image library, so the
 * page makes them: a tile that had to load the whole file draws it small, and sends that
 * to the portal (PUT /api/images/:id/thumb), which keeps it. Every view after that, on any
 * device, loads the small one. The first view of a picture is still the file.
 *
 * The copy is drawn from a fetch of the file, not from the tile's `<img>`: only a fetch says which
 * version it got (its ETag), and the portal refuses a copy of a version that is not the file's any more.
 */

/** The longest side of a small copy, in pixels: a tile is shown up to about 300 across, and a screen may have twice the pixels. */
const SIDE = 480;
/** A picture whose file is not larger than this is not worth a copy. */
const WORTH_IT = 48 * 1024;

/** The pictures a copy was sent for, or tried for, in this page: a refused one is not sent again at every tile that shows it. */
const tried = new Set<string>();
/** One at a time: a screenful of tiles that load together would otherwise make as many requests at once. */
let queue: Promise<unknown> = Promise.resolve();

/** A copy has to be well below the file, or it is no use to the person on a slow connection. */
const MAX_SHARE_OF_FILE = 0.5;

/** Whether a picture has any pixel that is not opaque: a JPEG would turn those black or white. */
function hasAlpha(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  try {
    const { data } = context.getImageData(0, 0, width, height);
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  } catch {
    // Cannot be read: taken as transparent, so that it is not lost.
    return true;
  }
  return false;
}

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });

/** `image` drawn at most `SIDE` across, as WebP where the browser can make that, else as JPEG (PNG only for a picture with transparency); none when it cannot be drawn. */
async function draw(image: HTMLImageElement): Promise<Blob | null> {
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!width || !height) return null;
  const scale = Math.min(1, SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const webp = await encode(canvas, "image/webp", 0.82);
  // A browser that cannot encode WebP (Safari) gives a PNG back, which for a photo is several times the file.
  if (!webp || webp.type === "image/webp") return webp;
  if (hasAlpha(context, canvas.width, canvas.height)) return webp;
  const jpeg = await encode(canvas, "image/jpeg", 0.82);
  return jpeg && jpeg.type === "image/jpeg" ? jpeg : webp;
}

/** The file as the portal sends it now, loaded to be drawn, with the version (ETag) of those very bytes. */
async function load(id: string): Promise<{ image: HTMLImageElement; version: string; release: () => void } | null> {
  const res = await fetch(api.galleryFileUrl(id));
  const version = res.headers.get("etag");
  if (!res.ok || !version) return null;
  const url = URL.createObjectURL(await res.blob());
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
  return { image, version, release: () => URL.revokeObjectURL(url) };
}

/**
 * Makes the small copy of a picture of the gallery from its file, and sends it with the version of
 * the file it was drawn from. Nothing is said of a failure: the tile shows the file, as it did before.
 * An animated picture and a small file are left as they are, and so is a picture where the copy would
 * not be much smaller than the file.
 */
export function keepThumb(id: string, picture?: { bytes: number; fileName: string }): void {
  if (tried.has(id)) return;
  if (picture && (picture.bytes <= WORTH_IT || /\.gif$/i.test(picture.fileName))) return;
  tried.add(id);
  queue = queue
    .then(async () => {
      const loaded = await load(id);
      if (!loaded) return;
      try {
        const blob = await draw(loaded.image);
        if (!blob || (picture && blob.size > picture.bytes * MAX_SHARE_OF_FILE)) return;
        await api.putGalleryThumb(id, blob, loaded.version);
      } finally {
        loaded.release();
      }
    })
    .catch(() => undefined);
}
