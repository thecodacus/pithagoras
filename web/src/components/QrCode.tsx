import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A QR code, drawn here from its text: what a channel asks to be scanned to
 * finish setting it up, such as Signal's link to a new device.
 *
 * Dark on white whatever the theme, with the quiet border around it that a
 * phone's camera needs to find the code: a light-on-dark one is not read by
 * every scanner.
 */
export function QrCode({ text, label, className = "" }: { text: string; label: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 4 });
    let d = "";
    qr.data.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x} ${y}h1v1h-1z`)));
    return { size: qr.size, path: d };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={`rounded-lg bg-white ${className}`}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
