import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

// Leaves a .br and a .gz beside each built file that is worth it, for the server
// to send to a browser that takes them. Done once here rather than for every
// request there: the ORT runtime alone is fourteen megabytes. Brotli at its
// slowest setting takes twenty seconds for that file and saves a tenth more than
// this one, which takes under one.

const root = path.resolve(process.argv[2] ?? "dist");
// What compresses. Pictures, fonts and archives already are, and gain nothing.
const TEXT = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".webmanifest", ".txt", ".map", ".wasm", ".onnx"]);
// A file this small costs more to ask for twice than it saves.
const MIN = 1024;

let packed = 0;
let before = 0;
let after = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile() && TEXT.has(path.extname(file).toLowerCase()) && statSync(file).size >= MIN) pack(file);
  }
}

function pack(file) {
  const body = readFileSync(file);
  const copies = [
    [".br", brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } })],
    [".gz", gzipSync(body, { level: 9 })],
  ];
  for (const [ext, data] of copies) {
    // Only where it is smaller, so a file the server finds a copy of is one it is worth sending.
    if (data.length >= body.length) continue;
    writeFileSync(file + ext, data);
    packed++;
    if (ext === ".br") {
      before += body.length;
      after += data.length;
    }
  }
}

walk(root);
console.log(`precompressed ${packed} copies in ${path.relative(process.cwd(), root) || "."}: ${(before / 1e6).toFixed(1)} MB as ${(after / 1e6).toFixed(1)} MB with brotli`);
