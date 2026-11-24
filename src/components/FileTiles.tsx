import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileAudio,
  FileText,
  FileVideo,
  MonitorUp,
  X,
} from "lucide-react";
import type { ArtifactThumbnail } from "../artifact-thumbnail";
import { fileSize } from "../attachments";
import { opensOnThisComputer, shownHere } from "../inbox";
import type { PreviewInput } from "../shared";
import { FileThumbnail } from "./ArtifactThumbnail";
import { Spinner } from "./UI";
import "../styles-files.css";

/** A file as a tile shows it. One without a hash is not kept on this side. */
export interface ShownFile {
  name: string;
  mime: string;
  size: number;
  sha256?: string;
}

/** Where a list of files comes from, and what can be done with one of them. */
export interface FileSource<File extends ShownFile> {
  /** Names the place, so previews of different places are kept apart. */
  key: string;
  bytes(file: File): Promise<{ base64: string }>;
  thumbnail(file: File): Promise<ArtifactThumbnail>;
  /** Shows a document in the isolated viewer. */
  show(file: File, bounds: PreviewInput["bounds"]): Promise<void>;
  open(file: File): Promise<void>;
  /** Somewhere else a file can be opened, such as Slack. */
  elsewhere?: { label: string; open(file: File): Promise<void> };
}

/** The most text shown of a log or a note. The whole of it opens on this computer. */
const MOST_TEXT = 200_000;

const bytesOf = (base64: string) =>
  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

/** A file's bytes as the window shows them: an address for a picture, or the text itself. */
function useContent<File extends ShownFile>(
  file: File | undefined,
  source: FileSource<File>,
) {
  const [shown, setShown] = useState<{ address?: string; text?: string }>({});
  const [problem, setProblem] = useState("");
  const kind = file && shownHere(file);
  const sha256 = file?.sha256;
  const mime = file?.mime ?? "";
  const latest = useRef({ file, source });
  latest.current = { file, source };
  useEffect(() => {
    setShown({});
    setProblem("");
    if (!kind || kind === "document" || !sha256) return;
    let current = true;
    let address: string | undefined;
    latest.current.source
      .bytes(latest.current.file!)
      .then(({ base64 }) => {
        if (!current) return;
        const bytes = bytesOf(base64);
        if (kind === "text") {
          const text = new TextDecoder().decode(bytes.subarray(0, MOST_TEXT));
          setShown({ text: bytes.length > MOST_TEXT ? text + "\n…" : text });
          return;
        }
        address = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setShown({ address });
      })
      .catch((error) => {
        if (current) setProblem((error as Error).message);
      });
    return () => {
      current = false;
      if (address) URL.revokeObjectURL(address);
    };
  }, [kind, sha256, mime, source.key]);
  return { kind, ...shown, problem };
}

/** Files with a preview of each. A click shows one large, or opens it where it can be seen. */
export function FileTiles<File extends ShownFile>({
  files,
  source,
  notify,
  about,
  below,
  onRemove,
}: {
  files: File[];
  source: FileSource<File>;
  /** Says what went wrong. Without it, the tiles say it themselves. */
  notify?: (message: string) => void;
  /** More to say about a file, under its size. */
  about?: (file: File) => React.ReactNode;
  /** More to do with a file, under its tile. */
  below?: (file: File, index: number) => React.ReactNode;
  onRemove?: (index: number) => void;
}) {
  const [openAt, setOpenAt] = useState<number>();
  const [problem, setProblem] = useState("");
  const say = (error: unknown) =>
    (notify ?? setProblem)((error as Error).message);
  const here = (file: File) => source.open(file).catch(say);
  const away = (file: File) => source.elsewhere?.open(file).catch(say);
  const open = (file: File, index: number) => {
    setProblem("");
    if (shownHere(file)) setOpenAt(index);
    else if (opensOnThisComputer(file)) void here(file);
    else void away(file);
  };
  const opened = openAt === undefined ? undefined : files[openAt];
  return (
    <>
      <div className="file-tiles">
        {files.map((file, index) => (
          <div
            key={(file.sha256 ?? "") + file.name + index}
            className="file-cell"
          >
            <Tile
              file={file}
              source={source}
              about={about?.(file)}
              onOpen={() => open(file, index)}
            />
            {onRemove && (
              <button
                type="button"
                className="file-remove"
                aria-label={`Remove ${file.name}`}
                title={`Remove ${file.name}`}
                onClick={() => onRemove(index)}
              >
                <X size={12} />
              </button>
            )}
            {below?.(file, index)}
          </div>
        ))}
      </div>
      {problem && <p className="file-problem">{problem}</p>}
      {opened && (
        <Viewer
          file={opened}
          source={source}
          position={files.length > 1 ? `${openAt! + 1} of ${files.length}` : ""}
          onStep={
            files.length > 1
              ? (by) => setOpenAt((openAt! + by + files.length) % files.length)
              : undefined
          }
          onHere={
            opensOnThisComputer(opened) ? () => void here(opened) : undefined
          }
          onElsewhere={source.elsewhere && (() => void away(opened))}
          onClose={() => setOpenAt(undefined)}
        />
      )}
    </>
  );
}

function Tile<File extends ShownFile>({
  file,
  source,
  about,
  onOpen,
}: {
  file: File;
  source: FileSource<File>;
  about: React.ReactNode;
  onOpen: () => void;
}) {
  const previewed = opensOnThisComputer(file);
  const isPicture = !previewed && shownHere(file) === "image";
  const { address } = useContent(isPicture ? file : undefined, source);
  const Kind = file.mime.startsWith("video/")
    ? FileVideo
    : file.mime.startsWith("audio/")
      ? FileAudio
      : FileText;
  const opens = shownHere(file) || previewed;
  return (
    <button
      type="button"
      className="file-tile"
      onClick={onOpen}
      disabled={!opens && !source.elsewhere}
      title={
        opens
          ? `Open ${file.name}`
          : source.elsewhere
            ? `${source.elsewhere.label}: ${file.name}`
            : file.name
      }
    >
      {previewed ? (
        <FileThumbnail
          name={file.name}
          id={`${source.key}:${file.sha256}:${file.name}`}
          read={() => source.thumbnail(file)}
        />
      ) : address ? (
        <img src={address} alt="" />
      ) : (
        <span className="file-tile-kind">
          <Kind size={18} />
        </span>
      )}
      <span className="file-tile-caption">
        <strong>{file.name}</strong>
        <span>{fileSize(file.size)}</span>
        {about}
      </span>
    </button>
  );
}

/** One file, large, over everything but the title bar. */
function Viewer<File extends ShownFile>({
  file,
  source,
  position,
  onStep,
  onHere,
  onElsewhere,
  onClose,
}: {
  file: File;
  source: FileSource<File>;
  position: string;
  onStep?: (by: 1 | -1) => void;
  onHere?: () => void;
  onElsewhere?: () => void;
  onClose: () => void;
}) {
  const { kind, address, text, problem } = useContent(file, source);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight") onStep?.(1);
      else if (event.key === "ArrowLeft") onStep?.(-1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose, onStep]);
  return createPortal(
    <div
      className="file-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      // It is drawn over whatever it was opened from: nothing it does reaches that.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <strong>{file.name}</strong>
        <span>
          {fileSize(file.size)}
          {position && ` · ${position}`}
        </span>
        <div>
          {onHere && (
            <button type="button" className="button secondary" onClick={onHere}>
              <MonitorUp size={13} /> Open on this computer
            </button>
          )}
          {onElsewhere && (
            <button
              type="button"
              className="button secondary"
              onClick={onElsewhere}
            >
              <ExternalLink size={13} /> {source.elsewhere?.label}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            autoFocus
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <div
        className="file-viewer-stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {problem && <p>{problem}</p>}
        {!problem &&
          kind &&
          kind !== "document" &&
          !address &&
          text === undefined && <Spinner />}
        {kind === "document" && <Document file={file} source={source} />}
        {!kind && <p>This file opens outside MemCode. Choose where above.</p>}
        {address && kind === "image" && <img src={address} alt={file.name} />}
        {address && kind === "video" && (
          <video src={address} controls autoPlay />
        )}
        {address && kind === "audio" && (
          <audio src={address} controls autoPlay />
        )}
        {text !== undefined && <pre>{text}</pre>}
      </div>
      {onStep && (
        <>
          <button
            type="button"
            className="file-viewer-step back"
            aria-label="Previous file"
            onClick={() => onStep(-1)}
          >
            <ChevronLeft size={20} />
          </button>
          <button
            type="button"
            className="file-viewer-step on"
            aria-label="Next file"
            onClick={() => onStep(1)}
          >
            <ChevronRight size={20} />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

/** A document in the isolated viewer, which is a window of its own over this place. */
function Document<File extends ShownFile>({
  file,
  source,
}: {
  file: File;
  source: FileSource<File>;
}) {
  const place = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState("");
  const { name, sha256 } = file;
  const latest = useRef({ file, source });
  latest.current = { file, source };
  useEffect(() => {
    setProblem("");
    let stopped = false;
    let frame: number | undefined;
    let shownAt = "";
    const show = () => {
      frame = undefined;
      const rect = place.current?.getBoundingClientRect();
      if (stopped || !rect || rect.width < 10 || rect.height < 10) return;
      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      const at = JSON.stringify(bounds);
      if (at === shownAt) return;
      shownAt = at;
      latest.current.source
        .show(latest.current.file, bounds)
        .then(() => {
          if (stopped) void window.memcode.hidePreview().catch(() => {});
        })
        .catch((error) => {
          if (!stopped) setProblem((error as Error).message);
        });
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(show);
    };
    const observer = new ResizeObserver(schedule);
    if (place.current) observer.observe(place.current);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      stopped = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      void window.memcode.hidePreview().catch(() => {});
    };
  }, [source.key, sha256, name]);
  return (
    <div ref={place} className="file-viewer-document">
      {problem ? <p>{problem}</p> : <Spinner />}
    </div>
  );
}
