import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

const MOST_PAGES = 100;
const MOST_TEXT = 200_000;
const PATIENCE_MS = 15_000;

/** The words of a PDF, page by page, for workers that cannot read one. Nothing if it has none. */
export async function pdfText(bytes: Uint8Array): Promise<string | undefined> {
  const job = getDocument({
    // PDF.js takes the bytes over: it gets its own.
    data: bytes.slice(),
    useSystemFonts: true,
    disableFontFace: true,
    enableXfa: false,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const pages: string[] = [];
  try {
    await Promise.race([
      (async () => {
        const document = await job.promise;
        for (let number = 1; number <= document.numPages; number++) {
          if (number > MOST_PAGES) {
            pages.push(`(${document.numPages - MOST_PAGES} more pages)`);
            break;
          }
          const content = await (
            await document.getPage(number)
          ).getTextContent();
          const words = content.items
            .map((item) =>
              "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "",
            )
            .join("")
            .trim();
          if (words) pages.push(`Page ${number}\n${words}`);
        }
      })(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, PATIENCE_MS);
      }),
    ]);
  } catch {
    // A damaged or locked PDF: a worker still gets the file itself.
  } finally {
    clearTimeout(timeout);
    await job.destroy();
  }
  return pages.join("\n\n").slice(0, MOST_TEXT) || undefined;
}
