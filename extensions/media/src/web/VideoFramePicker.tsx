import { useEffect, useRef, useState } from "react";
import { LuLoader, LuUpload } from "react-icons/lu";
import { portal, t } from "../portal";
import { api, type GalleryPicture } from "./api";
import { IMAGE_TYPES, sortFiles } from "./helpers";
import { appendNew } from "./gallery-list";

/** How many pictures a page of the choice has: enough to fill the dialog, and few enough to be quick. */
const PAGE = 24;

/**
 * The pictures to start a clip from, or to end it on (`which` frame): the pictures of the gallery, newest first, in a dialog, with a way to bring
 * in one of the person's own. A click on a picture chooses it and closes the dialog. The pictures are the page's
 * small copies where the portal made them, as the gallery's tiles are.
 */
export function VideoFramePicker({ which, onPick, onClose }: { which: "first" | "last"; onPick: (picture: GalleryPicture) => void; onClose: () => void }) {
  const { ui } = portal;
  const { button: btnCls, ghost: ghostCls } = ui.classes;
  const [pictures, setPictures] = useState<GalleryPicture[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    api.galleryPage({ limit: PAGE }).then(
      (page) => {
        if (!current) return;
        setPictures(page.pictures);
        setNext(page.next);
        setLoading(false);
      },
      (e: Error) => {
        if (!current) return;
        setError(e.message);
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const loadMore = () => {
    if (!next || more) return;
    setMore(true);
    api
      .galleryPage({ before: next, limit: PAGE })
      .then(
        (page) => {
          setPictures((cur) => appendNew(cur, page.pictures));
          setNext(page.next);
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setMore(false));
  };

  /** A picture from this computer goes into the gallery, as an edit's does, and is the choice. */
  const upload = async (picked: File[]) => {
    const { images, others } = sortFiles(picked);
    if (!images.length) return setError(t("{name} is not a PNG, JPEG, GIF or WebP picture", { name: others[0]?.name || t("Pasted picture") }));
    setError(null);
    setUploading(true);
    try {
      onPick(await api.uploadPicture(images[0]));
    } catch (e) {
      setError((e as Error).message);
      setUploading(false);
    }
  };

  return (
    <ui.Modal
      title={which === "first" ? t("Start from a picture") : t("End on a picture")}
      subtitle={which === "first" ? t("The picture is the first frame of the clip. Choose one from the gallery, or bring in your own.") : t("The picture is the last frame of the clip. Choose one from the gallery, or bring in your own.")}
      wide
      onClose={onClose}
    >
      <div className="space-y-3 px-5 py-4">
        {error && <ui.ErrorBanner onClose={() => setError(null)}>{error}</ui.ErrorBanner>}
        <div>
          <input
            ref={file}
            type="file"
            accept={IMAGE_TYPES.join(",")}
            className="sr-only"
            tabIndex={-1}
            aria-label={t("Upload a picture")}
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = "";
              void upload(picked);
            }}
          />
          <button type="button" onClick={() => file.current?.click()} disabled={uploading} className={btnCls}>
            {uploading ? <LuLoader aria-hidden className="h-4 w-4 animate-spin" /> : <LuUpload aria-hidden className="h-4 w-4" />}
            {t("Use a picture from this computer")}
          </button>
        </div>
        {loading ? (
          <div role="status" className="gallery-grid">
            <span className="sr-only">{t("Loading…")}</span>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton aspect-square rounded-lg" style={{ opacity: 1 - i * 0.12 }} />
            ))}
          </div>
        ) : pictures.length === 0 ? (
          <ui.Empty>{t("There are no pictures yet. Bring in one from this computer, or make some on the Media page.")}</ui.Empty>
        ) : (
          <ul className="gallery-grid" aria-label={t("Pictures")}>
            {pictures.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onPick(p)}
                  title={p.prompt || p.fileName}
                  aria-label={which === "first" ? t("Start from {name}", { name: p.prompt || p.fileName }) : t("End on {name}", { name: p.prompt || p.fileName })}
                  className="block w-full overflow-hidden rounded-lg border border-line bg-raised transition hover:border-accent/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <img src={p.thumb ? api.galleryThumbUrl(p.id) : api.galleryFileUrl(p.id)} alt="" loading="lazy" draggable={false} className="aspect-square w-full object-cover" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {next && (
          <div className="flex justify-center">
            <button type="button" onClick={loadMore} disabled={more} className={ghostCls}>
              {more ? t("Loading…") : t("Show more")}
            </button>
          </div>
        )}
      </div>
    </ui.Modal>
  );
}
