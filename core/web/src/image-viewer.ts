/**
 * What the picture viewer works with, and the arithmetic of looking at one.
 *
 * The viewer (components/ImageViewer.tsx) takes a list of pictures from whoever
 * opens it — the chat, and an extension's page (`ui.ImageViewer`) — and knows nothing about where
 * they come from. Here are the list's shape, how a picture and the one it was
 * edited from find each other, and the zoom and pan in numbers, so that they can
 * be checked without a page.
 */

export interface ViewerPicture {
  /** Tells it from the others in the list, and is what `from` of another points at. */
  id: string;
  /** Where the picture is, as an <img> takes it. Also what Open in a new tab and Download go to. */
  src: string;
  /** What it shows, for those who cannot see it. */
  alt: string;
  /** Shown under it, when there is something to say: its title. */
  caption?: string;
  /** What Download names the file, when the address does not say. */
  fileName?: string;
  /** The `id` of the picture this one was edited from, where that is known. */
  from?: string;
}

export interface Size {
  w: number;
  h: number;
}

/**
 * How the picture lies in its stage: `k` is how many screen pixels one pixel of
 * the picture takes, `x` and `y` where its top left corner is.
 */
export interface View {
  k: number;
  x: number;
  y: number;
}

/** Zoomed in as far as four screen pixels to one of the picture: past that there is nothing more to see. */
export const MAX_ZOOM = 4;
/** What a step of the zoom buttons and keys multiplies by. */
export const ZOOM_STEP = 1.5;

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

/**
 * The size that shows the whole picture in the stage, and never a larger one
 * than its own: a small picture is not blown up into a blur.
 */
export function fitScale(image: Size, stage: Size): number {
  if (!(image.w > 0 && image.h > 0 && stage.w > 0 && stage.h > 0)) return 1;
  return Math.min(1, stage.w / image.w, stage.h / image.h);
}

/**
 * `view` moved to the nearest one that is allowed: no smaller than the fitted
 * picture, no larger than `MAX_ZOOM`, centred on an axis where it does not
 * fill the stage, and not pulled off the edge where it does.
 */
export function clampView(view: View, image: Size, stage: Size): View {
  const fit = fitScale(image, stage);
  const k = clamp(view.k, fit, Math.max(MAX_ZOOM, fit));
  const [w, h] = [image.w * k, image.h * k];
  return {
    k,
    x: w <= stage.w ? (stage.w - w) / 2 : clamp(view.x, stage.w - w, 0),
    y: h <= stage.h ? (stage.h - h) / 2 : clamp(view.y, stage.h - h, 0),
  };
}

/** The whole picture, in the middle. */
export const fitted = (image: Size, stage: Size): View => clampView({ k: 0, x: 0, y: 0 }, image, stage);

/** Whether the picture lies as small as it can: nothing to move, and a swipe means the next picture. */
export const isFitted = (view: View, image: Size, stage: Size): boolean => view.k <= fitScale(image, stage) * 1.001;

/**
 * `view` at another size, with the spot of the picture that is under `at`
 * (in the stage's own coordinates) staying under it: a wheel or a pinch
 * zooms in on what the pointer is over, not on the middle.
 */
export function zoomAt(view: View, k: number, at: { x: number; y: number }, image: Size, stage: Size): View {
  const next = clamp(k, fitScale(image, stage), Math.max(MAX_ZOOM, fitScale(image, stage)));
  const ratio = next / view.k;
  return clampView({ k: next, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio }, image, stage);
}

/**
 * What a double tap does: a picture that is fitted goes to its own size, where
 * one screen pixel is one of the picture's — or to twice that, when it was
 * shown at its own size already — and any other goes back to fitted.
 */
export function toggled(view: View, at: { x: number; y: number }, image: Size, stage: Size): View {
  if (!isFitted(view, image, stage)) return fitted(image, stage);
  const fit = fitScale(image, stage);
  return zoomAt(view, fit < 1 ? 1 : 2, at, image, stage);
}

/** The place in a list `by` steps from `index`, or undefined at either end: it does not go round. */
export function stepped(index: number, length: number, by: 1 | -1): number | undefined {
  const to = index + by;
  return to >= 0 && to < length ? to : undefined;
}

/**
 * The picture `current` was edited from and the ones edited from it, as far as
 * they are in the list.
 */
export function linked(pictures: ViewerPicture[], current: ViewerPicture): { original?: ViewerPicture; edits: ViewerPicture[] } {
  return {
    original: current.from ? pictures.find((p) => p.id === current.from && p.id !== current.id) : undefined,
    edits: pictures.filter((p) => p.from === current.id && p.id !== current.id),
  };
}
