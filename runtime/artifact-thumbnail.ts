import { open, realpath, stat } from "node:fs/promises";
import { canonicalDirectories } from "./files";
import { extname } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import type { Artifact } from "../src/shared";
import type { ArtifactThumbnail } from "../src/artifact-thumbnail";
import { artifactFormat, artifactTypeLabel } from "../src/artifact-format";
import { inspectOfficeZip } from "../artifact-viewer/zip-limits";
import { within } from "./local";

const mime: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
};
function decode(value: string) {
  return value.replace(
    /&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi,
    (match, numeric: string | undefined, named: string | undefined) => {
      if (numeric) {
        const n = numeric.toLowerCase().startsWith("x")
          ? parseInt(numeric.slice(1), 16)
          : Number(numeric);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
      }
      return (
        (
          {
            amp: "&",
            lt: "<",
            gt: ">",
            quot: '"',
            apos: "'",
            nbsp: " ",
          } as Record<string, string>
        )[named!.toLowerCase()] ?? match
      );
    },
  );
}
/** The words of a piece of XML, without its tags. */
export function xmlText(value: string) {
  return text(value);
}
function text(value: string) {
  return decode(value.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}
function excerpts(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 14)
    .map((line) => line.slice(0, 350));
}
function office(
  bytes: Buffer,
  format: "docx" | "xlsx" | "pptx",
): ArtifactThumbnail {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  inspectOfficeZip(buffer);
  const wanted = new Set(
    format === "docx"
      ? ["word/document.xml"]
      : format === "pptx"
        ? ["ppt/slides/slide1.xml"]
        : [
            "xl/worksheets/sheet1.xml",
            "xl/sharedStrings.xml",
            "xl/workbook.xml",
          ],
  );
  const entries = unzipSync(bytes, {
    filter: (entry) =>
      wanted.has(entry.name) && entry.originalSize <= 2_000_000,
  });
  const xml = (name: string) => (entries[name] ? strFromU8(entries[name]) : "");
  if (format === "xlsx") {
    const strings = [
      ...xml("xl/sharedStrings.xml").matchAll(
        /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g,
      ),
    ].map((match) => text(match[1]));
    const rows = [
      ...xml("xl/worksheets/sheet1.xml").matchAll(
        /<row\b[^>]*>([\s\S]*?)<\/row>/g,
      ),
    ]
      .slice(0, 7)
      .map((row) => {
        const result: string[] = [];
        for (const match of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const ref = match[1].match(/\br="([A-Z]+)\d+"/)?.[1];
          const column = ref
            ? [...ref].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
            : result.length;
          if (column >= 5) continue;
          const raw = text(
            match[2].match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1] ?? match[2],
          );
          result[column] = (
            /\bt="s"/.test(match[1]) ? (strings[Number(raw)] ?? "") : raw
          ).slice(0, 120);
        }
        return Array.from(
          { length: Math.min(5, Math.max(1, result.length)) },
          (_, i) => result[i] ?? "",
        );
      });
    const title = decode(
      xml("xl/workbook.xml").match(/<sheet\b[^>]*\bname="([^"]+)"/)?.[1] ??
        "First worksheet",
    );
    return {
      kind: "document",
      format,
      title,
      lines: [],
      rows,
      label: "Worksheet excerpt",
    };
  }
  const source = xml(
    format === "docx" ? "word/document.xml" : "ppt/slides/slide1.xml",
  );
  const lines = [
    ...source.matchAll(
      format === "docx"
        ? /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
        : /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g,
    ),
  ]
    .map((match) => text(match[1]))
    .filter(Boolean)
    .slice(0, 14)
    .map((line) => line.slice(0, 350));
  return {
    kind: "document",
    format,
    title: lines[0],
    lines: lines.slice(1),
    label: format === "pptx" ? "First slide excerpt" : "Document excerpt",
  };
}

export async function readArtifactThumbnail(
  artifact: Pick<Artifact, "name" | "path">,
  roots: string[],
): Promise<ArtifactThumbnail> {
  const path = await realpath(artifact.path);
  const approvedRoots = await canonicalDirectories(roots);
  if (!approvedRoots.some((root) => within(root, path)))
    throw Error("Artifact path is outside the output folders.");
  const info = await stat(path);
  if (!info.isFile()) throw Error("Artifact is not a file.");
  const format = artifactFormat(artifact.name);
  const fallback = (detail: string): ArtifactThumbnail => ({
    kind: "fallback",
    format,
    label: artifactTypeLabel(artifact.name),
    detail,
  });
  if (format === "audio") return fallback("Audio recording · open to listen");
  if (format === "unsupported")
    return fallback("Open this saved document to view it");
  const binary = ["image", "pdf", "video", "docx", "xlsx", "pptx"].includes(
    format,
  );
  if (binary && info.size > (format === "image" ? 6_000_000 : 8_000_000))
    return fallback("Large file · open for the full preview");
  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    bytes = Buffer.alloc(Math.min(info.size, binary ? 8_000_000 : 48_000));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    bytes = bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (format === "image" || format === "pdf" || format === "video") {
    const type = mime[extname(path).toLowerCase()];
    if (!type) return fallback("Open to view this file");
    return {
      kind: format === "image" ? "image" : "media",
      format,
      dataUrl: `data:${type};base64,${bytes.toString("base64")}`,
    } as ArtifactThumbnail;
  }
  if (format === "docx" || format === "xlsx" || format === "pptx") {
    try {
      return office(bytes, format);
    } catch {
      return fallback("Document thumbnail unavailable · open to view");
    }
  }
  const content = bytes.toString("utf8");
  if (content.includes("\0")) return fallback("Binary file · open to view");
  if (format === "html") {
    const title = text(
      content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
    );
    const body = content
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<\/(?:p|div|h[1-6]|li|section|header|main)>/gi, "\n");
    return {
      kind: "document",
      format,
      title,
      lines: excerpts(body.split("\n").map(text).join("\n")),
      label: "Page text excerpt",
    };
  }
  return {
    kind: "document",
    format,
    lines: excerpts(content),
    label: format === "markdown" ? "Markdown excerpt" : "File excerpt",
  };
}
