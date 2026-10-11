import { rmSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./data-dir.js";

/** Where the small copies of the gallery's pictures are kept, one for each picture, under its id. */
export const thumbsDir = (): string => path.join(path.resolve(DATA_DIR), "image-thumbs");
export const thumbFile = (id: string): string => path.join(thumbsDir(), `${id}.thumb`);

/** The small copy has no use without its picture: gone with it, wherever the picture's row is deleted. */
export function removeThumbs(ids: string[]): void {
  for (const id of ids) rmSync(thumbFile(id), { force: true });
}
