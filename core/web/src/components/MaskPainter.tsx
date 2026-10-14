import { forwardRef, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { LuEraser, LuPaintbrush } from "react-icons/lu";
import { btnCls } from "./SettingsUi";
import { blobBase64 } from "../attachments";
import { t } from "../i18n";

/** What is painted is kept this small at most: the mask is made at the picture's own size only when it is sent. */
const LONGEST = 1024;

export interface MaskHandle {
  /** The mask as a PNG in base64, transparent where the person painted; null when nothing is painted. */
  mask: () => Promise<string | null>;
}

/**
 * Paint over the picture where it should change, for an edit that takes a
 * mask. What is painted shows over the picture in colour, and becomes the
 * mask when it is sent: the picture's own size, opaque everywhere but where
 * it was painted, which is transparent — the area an endpoint changes.
 * Painting is with a pointer or a finger; the mask is optional, and without it
 * the whole picture may change.
 */
export const MaskPainter = forwardRef<MaskHandle, { src: string }>(function MaskPainter({ src }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [brush, setBrush] = useState(10);
  const [erase, setErase] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // The paint is as large as the picture's shape and `LONGEST` allow, and as large on the screen as the picture is.
  const size = (el: HTMLImageElement) => {
    const scale = Math.min(1, LONGEST / Math.max(el.naturalWidth, el.naturalHeight));
    const c = canvas.current!;
    c.width = Math.max(1, Math.round(el.naturalWidth * scale));
    c.height = Math.max(1, Math.round(el.naturalHeight * scale));
    setReady(true);
  };

  const at = (e: ReactPointerEvent): { x: number; y: number } => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  };

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    // The brush is as wide on the screen as it says, whatever the picture's size.
    const shown = c.getBoundingClientRect().width || c.width;
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = "#ff3b6b";
    ctx.fillStyle = "#ff3b6b";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = (brush * c.width) / shown;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    last.current = p;
    // A tap is a dot.
    stroke(p, p);
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!last.current) return;
    const p = at(e);
    stroke(last.current, p);
    last.current = p;
  };
  const up = () => {
    last.current = null;
  };

  const clear = () => {
    const c = canvas.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  };

  useImperativeHandle(ref, () => ({
    async mask() {
      const paint = canvas.current;
      const el = image.current;
      if (!paint || !el || !ready) return null;
      const pixels = paint.getContext("2d")!.getImageData(0, 0, paint.width, paint.height).data;
      let any = false;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] > 0) {
          any = true;
          break;
        }
      }
      if (!any) return null;
      const out = document.createElement("canvas");
      out.width = el.naturalWidth;
      out.height = el.naturalHeight;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error(t("The mask could not be made for a picture this large"));
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(paint, 0, 0, out.width, out.height);
      const blob = await new Promise<Blob | null>((done) => out.toBlob(done, "image/png"));
      if (!blob) throw new Error(t("The mask could not be made for a picture this large"));
      return blobBase64(blob);
    },
  }));

  if (failed) return <p className="text-xs text-fg-subtle">{t("The picture could not be loaded.")}</p>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setErase(false)} aria-pressed={!erase} className={`${btnCls} ${!erase ? "ring-1 ring-inset ring-accent/40" : ""}`}>
          <LuPaintbrush aria-hidden className="h-4 w-4" />
          {t("Paint")}
        </button>
        <button type="button" onClick={() => setErase(true)} aria-pressed={erase} className={`${btnCls} ${erase ? "ring-1 ring-inset ring-accent/40" : ""}`}>
          <LuEraser aria-hidden className="h-4 w-4" />
          {t("Erase")}
        </button>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          {t("Brush")}
          <input type="range" min={4} max={80} value={brush} onChange={(e) => setBrush(Number(e.target.value))} className="w-28 accent-[rgb(var(--accent))]" />
        </label>
        <button type="button" onClick={clear} disabled={!ready} className={btnCls}>
          {t("Clear the mask")}
        </button>
      </div>
      <div className="mask-painter relative inline-block max-w-full overflow-hidden rounded-lg border border-line bg-raised/60 align-top">
        <img ref={image} src={src} alt={t("The picture to change")} draggable={false} onLoad={(e) => size(e.currentTarget)} onError={() => setFailed(true)} className="block max-h-[50vh] max-w-full select-none" />
        <canvas
          ref={canvas}
          aria-label={t("Paint over the part that should change")}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className="absolute inset-0 h-full w-full cursor-crosshair opacity-60"
          style={{ touchAction: "none" }}
        />
      </div>
    </div>
  );
});
