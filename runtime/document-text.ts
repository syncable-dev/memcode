import { strFromU8, unzipSync } from "fflate";
import { inspectOfficeZip } from "../artifact-viewer/zip-limits";
import { artifactFormat } from "../src/artifact-format";
import { xmlText } from "./artifact-thumbnail";

/** The most text taken from one document. A worker can still open the file itself. */
export const MOST_DOCUMENT_TEXT = 200_000;
const MOST_ROWS = 2_000;
const LARGEST_PART = 16_000_000;

/**
 * The words of a document as plain text, for workers that cannot read its format: the
 * paragraphs of a Word file, the slides of a presentation, the cells of a workbook.
 * Nothing for any other kind of file, or for one that cannot be read.
 */
export function documentText(
  name: string,
  bytes: Uint8Array,
): string | undefined {
  const format = artifactFormat(name);
  if (format !== "docx" && format !== "xlsx" && format !== "pptx")
    return undefined;
  try {
    inspectOfficeZip(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
    const parts = unzipSync(bytes, {
      filter: (entry) =>
        entry.originalSize <= LARGEST_PART &&
        /^(word\/document|ppt\/slides\/slide\d+|xl\/worksheets\/sheet\d+|xl\/sharedStrings|xl\/workbook)\.xml$/.test(
          entry.name,
        ),
    });
    const read = (part: string) => (parts[part] ? strFromU8(parts[part]) : "");
    const text =
      format === "docx"
        ? paragraphs(read("word/document.xml"), "w").join("\n")
        : format === "pptx"
          ? numbered(parts, "ppt/slides/slide")
              .map(
                (part, index) =>
                  `Slide ${index + 1}\n${paragraphs(read(part), "a").join("\n")}`,
              )
              .join("\n\n")
          : workbook(parts, read);
    return text.trim().slice(0, MOST_DOCUMENT_TEXT) || undefined;
  } catch {
    return undefined;
  }
}

/** The numbered parts of an archive, in order: slide2 before slide10. */
function numbered(parts: Record<string, Uint8Array>, prefix: string): string[] {
  const number = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1]);
  return Object.keys(parts)
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => number(a) - number(b));
}

function paragraphs(xml: string, space: "w" | "a"): string[] {
  return [
    ...xml.matchAll(
      new RegExp(`<${space}:p(?:\\s[^>]*)?>([\\s\\S]*?)</${space}:p>`, "g"),
    ),
  ]
    .map((match) => xmlText(match[1]))
    .filter(Boolean);
}

function workbook(
  parts: Record<string, Uint8Array>,
  read: (part: string) => string,
): string {
  const strings = [
    ...read("xl/sharedStrings.xml").matchAll(
      /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g,
    ),
  ].map((match) => xmlText(match[1]));
  const names = [
    ...read("xl/workbook.xml").matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g),
  ].map((match) => xmlText(match[1]));
  return numbered(parts, "xl/worksheets/sheet")
    .map((part, index) => {
      const rows = [...read(part).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)];
      const lines = rows.slice(0, MOST_ROWS).map((row) => {
        const cells: string[] = [];
        for (const match of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const letters = match[1].match(/\br="([A-Z]{1,3})\d+"/)?.[1];
          const column = letters
            ? [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) -
              1
            : cells.length;
          const value = xmlText(
            match[2].match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1] ?? match[2],
          );
          cells[Math.min(column, 200)] = /\bt="s"/.test(match[1])
            ? (strings[Number(value)] ?? "")
            : value;
        }
        return Array.from(cells, (cell) => cell ?? "").join("\t");
      });
      const left = rows.length - lines.length;
      return [
        `Sheet: ${names[index] ?? index + 1}`,
        ...lines,
        ...(left > 0 ? [`(${left} more rows)`] : []),
      ].join("\n");
    })
    .join("\n\n");
}
