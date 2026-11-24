import { useEffect, useRef, useState } from "react";
import {
  FileText,
  Film,
  Headphones,
  Image as ImageIcon,
  Play,
  Table2,
} from "lucide-react";
import type { Artifact } from "../shared";
import type { ArtifactThumbnail as Thumbnail } from "../artifact-thumbnail";
import { artifactFormat, artifactTypeLabel } from "../artifact-format";

const cache = new Map<string, Promise<Thumbnail>>();
const queue: (() => void)[] = [];
let active = 0;
function schedule<T>(work: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      active++;
      void work()
        .then(resolve, reject)
        .finally(() => {
          active--;
          queue.shift()?.();
        });
    };
    if (active < 2) start();
    else queue.push(start);
  });
}
function binary(dataUrl: string) {
  const data = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  return Uint8Array.from(data, (c) => c.charCodeAt(0));
}
function downsize(source: CanvasImageSource, width: number, height: number) {
  if (!width || !height || width * height > 80_000_000)
    throw Error("Image exceeds thumbnail dimensions.");
  const scale = Math.min(1, 600 / width, 400 / height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw Error("Thumbnail unavailable.");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.82);
}
async function imageThumbnail(dataUrl: string) {
  const image = new window.Image();
  image.src = dataUrl;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      image.decode(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(Error("Image thumbnail timed out.")),
          5000,
        );
      }),
    ]);
    return downsize(image, image.naturalWidth, image.naturalHeight);
  } finally {
    clearTimeout(timeout);
    image.src = "";
  }
}
async function videoThumbnail(dataUrl: string) {
  const bytes = binary(dataUrl);
  const type = dataUrl.slice(5, dataUrl.indexOf(";"));
  const blob = URL.createObjectURL(new Blob([bytes], { type }));
  const video = document.createElement("video");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(Error("Video thumbnail unavailable."));
      timeout = setTimeout(
        () => reject(Error("Video thumbnail timed out.")),
        5000,
      );
      video.src = blob;
      video.load();
    });
    return downsize(video, video.videoWidth, video.videoHeight);
  } finally {
    clearTimeout(timeout);
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(blob);
  }
}
function load(key: string, name: string, read: () => Promise<Thumbnail>) {
  let result = cache.get(key);
  if (!result) {
    result = schedule(async (): Promise<Thumbnail> => {
      try {
        const value = await read();
        if (value.kind === "image")
          return { ...value, dataUrl: await imageThumbnail(value.dataUrl) };
        if (value.kind === "media") {
          const dataUrl =
            value.format === "pdf"
              ? await (
                  await import("../artifact-pdf-thumbnail")
                ).pdfThumbnail(binary(value.dataUrl))
              : await videoThumbnail(value.dataUrl);
          return { kind: "image", format: value.format, dataUrl };
        }
        return value;
      } catch {
        return {
          kind: "fallback",
          format: artifactFormat(name),
          label: artifactTypeLabel(name),
          detail: "Open for the full preview",
        };
      }
    });
    cache.set(key, result);
    if (cache.size > 72) cache.delete(cache.keys().next().value!);
  }
  return result;
}
function readable(line: string) {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1");
}

export function ArtifactThumbnail({ artifact }: { artifact: Artifact }) {
  return (
    <FileThumbnail
      name={artifact.name}
      id={`${artifact.id}:${artifact.revision ?? artifact.createdAt}:${artifact.path}`}
      read={() => window.memcode.readArtifactThumbnail(artifact.id)}
    />
  );
}

/** A small, inert preview of a saved file. `id` names this version of it. */
export function FileThumbnail({
  name,
  id,
  read,
}: {
  name: string;
  id: string;
  read: () => Promise<Thumbnail>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumbnail, setThumbnail] = useState<Thumbnail | null>(null);
  useEffect(() => {
    setThumbnail(null);
    let current = true;
    let delayed: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        // A stalled native read must not leave the gallery looking unfinished.
        // Keep its queue slot until it settles: a visual deadline is not an
        // excuse to launch more than two uncancelled native reads.
        delayed = setTimeout(() => {
          if (current)
            setThumbnail({
              kind: "fallback",
              format: artifactFormat(name),
              label: artifactTypeLabel(name),
              detail: "Preview delayed · open to view the file",
            });
        }, 8000);
        void load(id, name, read).then((value) => {
          clearTimeout(delayed);
          if (current) setThumbnail(value);
        });
      },
      { rootMargin: "100px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => {
      current = false;
      clearTimeout(delayed);
      observer.disconnect();
    };
  }, [id, name]);
  const format = thumbnail?.format ?? artifactFormat(name);
  return (
    <div
      ref={ref}
      className={`artifact-tile-preview artifact-thumbnail format-${format}`}
      aria-label={`${artifactTypeLabel(name)} preview`}
    >
      {!thumbnail ? (
        <div
          className="artifact-thumbnail-loading"
          aria-label="Loading preview"
        >
          <i />
          <i />
          <i />
        </div>
      ) : thumbnail.kind === "image" ? (
        <>
          <img
            src={thumbnail.dataUrl}
            alt={`Preview of ${name}`}
            loading="lazy"
            decoding="async"
          />
          {format === "video" && (
            <span className="artifact-thumbnail-play">
              <Play size={17} fill="currentColor" />
            </span>
          )}
          {format === "pdf" && (
            <span className="artifact-thumbnail-page">Page 1</span>
          )}
        </>
      ) : thumbnail.kind === "document" ? (
        <>
          <div
            className={
              "artifact-thumbnail-document " +
              (thumbnail.rows ? "is-sheet" : "")
            }
          >
            {thumbnail.title && <strong>{readable(thumbnail.title)}</strong>}
            {thumbnail.rows ? (
              <table>
                <tbody>
                  {thumbnail.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div>
                {thumbnail.lines.map((line, i) => (
                  <div
                    key={i}
                    className={/^#{1,6}\s/.test(line) ? "is-heading" : ""}
                  >
                    {readable(line)}
                  </div>
                ))}
              </div>
            )}
          </div>
          <span className="artifact-thumbnail-caption">{thumbnail.label}</span>
        </>
      ) : (
        <div className="artifact-thumbnail-fallback">
          {format === "video" ? (
            <Film size={23} />
          ) : format === "audio" ? (
            <Headphones size={23} />
          ) : format === "xlsx" ? (
            <Table2 size={23} />
          ) : format === "image" ? (
            <ImageIcon size={23} />
          ) : (
            <FileText size={23} />
          )}
          <strong>
            {thumbnail.kind === "fallback"
              ? thumbnail.label
              : artifactTypeLabel(name)}
          </strong>
          <span>
            {thumbnail.kind === "fallback"
              ? thumbnail.detail
              : "Open for the full preview"}
          </span>
        </div>
      )}
    </div>
  );
}
