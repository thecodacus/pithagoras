import { api } from "./api";

/**
 * The small copies of the gallery's pictures. The portal has no image library, so the
 * page makes them: a tile that had to load the whole file draws it small, and sends that
 * to the portal (PUT /api/images/:id/thumb), which keeps it. Every view after that, on any
 * device, loads the small one. The first view of a picture is still the file.
 */

/** The longest side of a small copy, in pixels: a tile is shown up to about 300 across, and a screen may have twice the pixels. */
const SIDE = 480;
/** A picture whose file is not larger than this is not worth a copy. */
const WORTH_IT = 48 * 1024;

/** The pictures a copy was sent for, or tried for, in this page: a refused one is not sent again at every tile that shows it. */
const tried = new Set<string>();
/** One at a time: a screenful of tiles that load together would otherwise make as many requests at once. */
let queue: Promise<unknown> = Promise.resolve();

/** `image` drawn at most `SIDE` across, as WebP where the browser can make that and PNG where it cannot; none when it cannot be drawn. */
async function draw(image: HTMLImageElement): Promise<Blob | null> {
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!width || !height) return null;
  const scale = Math.min(1, SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/webp", 0.82);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Makes the small copy of a picture of the gallery from the `<img>` that has loaded its file, and
 * sends it. Nothing is said of a failure: the tile shows the file, as it did before.
 * An animated picture and a small file are left as they are.
 */
export function keepThumb(id: string, image: HTMLImageElement, picture?: { bytes: number; fileName: string }): void {
  if (tried.has(id)) return;
  if (picture && (picture.bytes <= WORTH_IT || /\.gif$/i.test(picture.fileName))) return;
  tried.add(id);
  queue = queue
    .then(async () => {
      const blob = await draw(image);
      if (blob) await api.putGalleryThumb(id, blob);
    })
    .catch(() => undefined);
}
