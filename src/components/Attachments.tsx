import { useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import {
  fileSize,
  LARGEST_ATTACHMENT,
  LONGEST_NOTE,
  MOST_ATTACHMENTS,
  withAttachments,
  type Attachment,
} from "../attachments";
import { FileTiles, type FileSource } from "./FileTiles";
import { Spinner } from "./UI";

const attached: FileSource<Attachment> = {
  key: "attached",
  bytes: ({ sha256, name }) => window.memcode.attachmentBytes({ sha256, name }),
  thumbnail: ({ sha256, name }) =>
    window.memcode.attachmentThumbnail({ sha256, name }),
  show: ({ sha256, name }, bounds) =>
    window.memcode.showAttachment({ sha256, name, bounds }),
  open: ({ sha256, name }) => window.memcode.openAttachment({ sha256, name }),
};

const base64Of = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const address = String(reader.result);
      resolve(address.slice(address.indexOf(",") + 1));
    };
    reader.onerror = () =>
      reject(new Error("The file could not be read. Try again."));
    reader.readAsDataURL(file);
  });

/** Keeps one file in MemCode's folder, with a PDF's words for workers that read no PDF. */
export async function keepFile(file: File, from?: string): Promise<Attachment> {
  if (file.size > LARGEST_ATTACHMENT)
    throw new Error(
      `${file.name} is ${fileSize(file.size)}. Files can be up to ${fileSize(LARGEST_ATTACHMENT)}.`,
    );
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const text = isPdf
    ? await import("../pdf-text")
        .then(async ({ pdfText }) =>
          pdfText(new Uint8Array(await file.arrayBuffer())),
        )
        .catch(() => undefined)
    : undefined;
  return window.memcode.addAttachment({
    name: file.name || "file",
    mime: file.type,
    base64: await base64Of(file),
    ...(text ? { text } : {}),
    ...(from ? { from } : {}),
  });
}

/** A pasted picture has no name of its own. */
const named = (file: File) =>
  /^image\.(png|jpe?g|gif|webp)$/i.test(file.name)
    ? new File(
        [file],
        `pasted-${new Date().toISOString().slice(11, 19).replaceAll(":", "")}.${file.name.split(".").at(-1)}`,
        { type: file.type },
      )
    : file;

/**
 * Adding files to something being written: with a button, by dropping them on it, or by
 * pasting. Spread `drop` on what files may be dropped on, and `paste` on its text field.
 */
export function useAttach(
  items: Attachment[],
  setItems: (change: (items: Attachment[]) => Attachment[]) => void,
  notify: (message: string) => void,
) {
  const [adding, setAdding] = useState(0);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const add = async (files: File[]) => {
    const room = MOST_ATTACHMENTS - items.length;
    if (files.length > room)
      notify(`Up to ${MOST_ATTACHMENTS} files can be attached.`);
    const taken = files.slice(0, Math.max(0, room));
    setAdding((count) => count + taken.length);
    for (const file of taken)
      try {
        const kept = await keepFile(file);
        setItems((known) => withAttachments(known, [kept]));
      } catch (error) {
        notify((error as Error).message);
      } finally {
        setAdding((count) => count - 1);
      }
  };
  const carriesFiles = (event: React.DragEvent) =>
    [...event.dataTransfer.types].includes("Files");
  return {
    adding,
    over,
    add,
    choose: () => input.current?.click(),
    input,
    drop: {
      onDragOver: (event: React.DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOver(false);
      },
      onDrop: (event: React.DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        void add([...event.dataTransfer.files]);
      },
    },
    paste: {
      onPaste: (event: React.ClipboardEvent) => {
        const files = [...event.clipboardData.files];
        if (!files.length) return;
        event.preventDefault();
        void add(files.map(named));
      },
    },
  };
}
export type Attach = ReturnType<typeof useAttach>;

/** The paperclip. */
export function AttachButton({
  attach,
  disabled,
  label,
}: {
  attach: Attach;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <>
      <input
        ref={attach.input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void attach.add([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className={label ? "attach-button labelled" : "attach-button"}
        title="Attach images, PDFs, spreadsheets, presentations or any file"
        aria-label="Attach files"
        disabled={disabled}
        onClick={attach.choose}
      >
        {attach.adding > 0 ? <Spinner size={14} /> : <Paperclip size={15} />}
        {label}
      </button>
    </>
  );
}

/** Files about to be sent, each with a preview and a way to take it off again. */
export function AttachedFiles({
  items,
  setItems,
  notify,
  notes,
}: {
  items: Attachment[];
  setItems: (change: (items: Attachment[]) => Attachment[]) => void;
  notify: (message: string) => void;
  /** Whether each file has a line to say what it shows. */
  notes?: boolean;
}) {
  if (!items.length) return null;
  return (
    <div className="attached-files">
      <FileTiles
        files={items}
        source={attached}
        notify={notify}
        about={(file) => file.from && <small>From {file.from}</small>}
        onRemove={(index) =>
          setItems((known) => known.filter((_, at) => at !== index))
        }
        below={
          notes
            ? (file, index) => (
                <input
                  className="file-note"
                  value={file.note ?? ""}
                  maxLength={LONGEST_NOTE}
                  placeholder="What does this show?"
                  aria-label={`What ${file.name} shows`}
                  onChange={(event) => {
                    const note = event.target.value;
                    setItems((known) =>
                      known.map((item, at) =>
                        at === index
                          ? { ...item, note: note || undefined }
                          : item,
                      ),
                    );
                  }}
                />
              )
            : undefined
        }
      />
    </div>
  );
}

/** The files of a message that was sent. */
export function MessageFiles({ files }: { files: Attachment[] }) {
  return (
    <div className="attached-files sent">
      <FileTiles
        files={files}
        source={attached}
        about={(file) => (
          <>
            {file.from && <small>From {file.from}</small>}
            {file.note && <small>{file.note}</small>}
          </>
        )}
      />
    </div>
  );
}
