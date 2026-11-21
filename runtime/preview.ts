import { createServer, type Server, type ServerResponse } from "node:http";
import { realpath, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname, basename, extname, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { AppState, PreviewInput, WorkItem } from "../src/shared";
import type { NativeHost, Emit } from "./host";
import { within, now } from "./local";
import { localURL } from "./urls";
import { artifactFormat } from "../src/artifact-format";
import { outputRoots, canonicalArtifactRoots, resolveFile } from "./files";
import { streamArtifact } from "./artifact-stream";
import { selectionSchema } from "../src/review";

export const artifactRoots = outputRoots;
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};
const localSources =
  "http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:* http://[::1]:* https://[::1]:*";
const policy = `default-src 'self' data: blob: ${localSources}; script-src 'self' 'unsafe-inline' 'unsafe-eval' ${localSources}; style-src 'self' 'unsafe-inline' ${localSources}; connect-src 'self' ${localSources} ws://localhost:* ws://127.0.0.1:* ws://[::1]:*; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self' ${localSources}`;
interface Resource {
  token: string;
  root?: string;
  entry?: string;
  target?: URL;
  document?: {
    path: string;
    format: string;
    name: string;
    taskId: string;
    artifactId?: string;
    revision: string;
    line?: number;
    focusedCommentId?: string;
    focusVersion?: number;
  };
}

export class PreviewManager {
  private server?: Server;
  private origin = "";
  private resource?: Resource;
  private owner = "";
  private visible = false;
  private bounds?: PreviewInput["bounds"];
  private key = "";
  private generation = 0;
  private nativeQueue: Promise<unknown> = Promise.resolve();
  private listening?: Promise<void>;
  private resources = new Map<string, Resource>();
  private commentStreams = new Map<ServerResponse, Resource>();
  private selectionEpoch = 0;
  constructor(
    private host: NativeHost,
    private state: () => AppState,
    private dataDir: string,
    private changed: () => Promise<void>,
    private emit: Emit,
    private appPath = process.cwd(),
  ) {}
  async show(input: PreviewInput): Promise<void> {
    const generation = ++this.generation;
    const task = this.state().tasks.find((task) => task.id === input.taskId);
    if (!task) throw new Error("Task not found.");
    const artifactRevision =
      this.state().artifacts.find(
        (artifact) => artifact.id === input.artifactId,
      )?.revision ?? "";
    const key =
      input.taskId +
      ":" +
      (input.artifactId ?? input.filePath ?? input.url ?? "") +
      ":" +
      (input.line ?? "") +
      ":" +
      (input.fileRevision ?? artifactRevision);
    if (key !== this.key) {
      let resource: Resource = { token: randomBytes(20).toString("hex") };
      if (input.artifactId || input.filePath) {
        const artifact = this.state().artifacts.find(
          (artifact) =>
            artifact.id === input.artifactId && artifact.taskId === task.id,
        );
        if (input.artifactId && !artifact)
          throw new Error("Artifact not found in this task.");
        const file = await resolveFile(
          this.state(),
          this.dataDir,
          task.id,
          artifact?.path ?? input.filePath!,
        );
        const path = file.path;
        if (
          artifact &&
          !(await canonicalArtifactRoots(this.dataDir, task)).some((root) =>
            within(root, path),
          )
        )
          throw new Error(
            "The artifact is outside this worker’s output folders.",
          );
        resource = { ...resource, root: dirname(path), entry: basename(path) };
        const format = file.format;
        resource.document = {
          path,
          format,
          name: artifact?.name ?? file.relativePath,
          taskId: task.id,
          artifactId: artifact?.id,
          revision: file.revision,
          line: input.line,
        };
        if (format !== "html") {
          const development = join(this.appPath, "dist-artifact-viewer");
          const packaged = join(this.appPath, "artifact-viewer");
          const viewer = await realpath(
            await stat(development)
              .then(() => development)
              .catch(() => packaged),
          );
          if (
            !(
              await stat(join(viewer, "index.html")).catch(() => null)
            )?.isFile()
          )
            throw Error(
              "Build the artifact viewer before opening this document.",
            );
          resource = {
            ...resource,
            root: viewer,
            entry: "index.html",
            document: {
              path,
              format,
              name: artifact?.name ?? file.relativePath,
              taskId: task.id,
              artifactId: artifact?.id,
              revision: file.revision,
              line: input.line,
            },
          };
        }
      } else resource.target = localURL(input.url ?? "");
      if (generation !== this.generation) return;
      this.resources.set(resource.token, resource);
      while (this.resources.size > 16)
        this.resources.delete(this.resources.keys().next().value!);
      this.resource = resource;
      this.key = key;
    }
    await this.listen();
    if (generation !== this.generation) return;
    this.owner = task.id;
    this.bounds = input.bounds;
    this.visible = true;
    const resource = this.resource!;
    if (
      resource.document &&
      (resource.document.focusedCommentId !== input.commentId ||
        resource.document.focusVersion !== input.commentFocus)
    ) {
      resource.document.focusedCommentId = input.commentId;
      resource.document.focusVersion = input.commentFocus;
      this.publishComments();
    }
    const suffix = resource.entry
      ? encodeURIComponent(resource.entry)
      : resource.target!.pathname.slice(1) + resource.target!.search;
    const url = `${this.origin}/p/${resource.token}/${suffix}`;
    await this.native(generation, "preview_show", {
      url,
      bounds: input.bounds,
    });
    if (generation !== this.generation) return;
    this.emit("preview:event", {
      url: input.url ?? "",
      title: input.artifactId
        ? this.state().artifacts.find((a) => a.id === input.artifactId)?.name
        : "Local preview",
    });
  }
  async hide(): Promise<void> {
    const generation = ++this.generation;
    this.visible = false;
    await this.native(generation, "preview_hide", {});
  }
  private commentData(resource: Resource) {
    const doc = resource.document!;
    return {
      comments: (this.state().reviewComments ?? []).filter(
        (comment) =>
          comment.taskId === doc.taskId &&
          ((!!doc.artifactId &&
            comment.reference.artifactId === doc.artifactId) ||
            comment.reference.path === doc.path),
      ),
      focusedId: doc.focusedCommentId,
      focusVersion: doc.focusVersion,
      revision: doc.revision,
      selectionEpoch: this.selectionEpoch,
    };
  }
  publishComments() {
    for (const [response, resource] of this.commentStreams) {
      if (response.destroyed) {
        this.commentStreams.delete(response);
        continue;
      }
      response.write(
        "data: " + JSON.stringify(this.commentData(resource)) + "\n\n",
      );
    }
  }
  private native(generation: number, method: string, input: unknown) {
    const operation = this.nativeQueue
      .catch(() => {})
      .then(() => {
        if (generation === this.generation)
          return this.host.call(method, input);
      });
    this.nativeQueue = operation;
    return operation;
  }
  async action(
    action: "back" | "forward" | "reload" | "capture" | "clear-selection",
  ): Promise<void> {
    if (action === "clear-selection") {
      this.selectionEpoch++;
      this.publishComments();
      return;
    }
    if (!this.visible || !this.resource)
      throw new Error("Open a preview first.");
    if (action !== "capture") {
      await this.host.call("preview_action", { action });
      return;
    }
    const task = this.state().tasks.find((task) => task.id === this.owner);
    const generation = this.generation;
    if (!task) throw new Error("Task not found.");
    const result = await this.host.call<{ pngBase64: string }>(
      "preview_capture",
      { bounds: this.bounds },
    );
    const bytes = Buffer.from(result.pngBase64, "base64");
    if (generation !== this.generation)
      throw Error(
        "The artifact changed during capture. Capture the current view again.",
      );
    if (
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("The native preview did not return a PNG capture.");
    const root = join(this.dataDir, "captures", task.id);
    if (!within(join(this.dataDir, "captures"), root))
      throw new Error("Invalid capture owner.");
    await mkdir(root, { recursive: true });
    const name = `preview-${now().replace(/[:.]/g, "-")}.png`,
      path = join(root, name);
    await writeFile(path, bytes);
    this.state().artifacts.push({
      id: randomUUID(),
      name,
      kind: "image",
      path,
      taskId: task.id,
      projectId: task.projectId,
      createdAt: now(),
      source: "Visible local preview",
    });
    await this.changed();
  }
  private listen() {
    return (this.listening ??= this.startServer());
  }
  private async startServer() {
    if (this.server) return;
    this.server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", this.origin);
        const token = url.pathname.match(/^\/p\/([a-f0-9]{40})\//)?.[1];
        const resource = token ? this.resources.get(token) : this.resource;
        if (!resource) throw new Error("Preview token expired.");
        const prefix = `/p/${resource.token}/`;
        if (resource.document && !url.pathname.startsWith(prefix))
          throw Error("Preview token expired.");
        const relative = url.pathname.startsWith(prefix)
          ? url.pathname.slice(prefix.length)
          : url.pathname.startsWith("/p/")
            ? null
            : url.pathname.slice(1);
        if (relative === null) throw new Error("Preview token expired.");
        response.setHeader(
          "Content-Security-Policy",
          resource.document && resource.document.format !== "html"
            ? "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
            : policy,
        );
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        if (
          resource.document?.format === "html" &&
          relative.startsWith("__review-ui/")
        ) {
          const folder = await realpath(
              await stat(join(this.appPath, "dist-artifact-annotations"))
                .then(() => join(this.appPath, "dist-artifact-annotations"))
                .catch(() => join(this.appPath, "artifact-annotations")),
            ),
            path = await realpath(
              resolve(folder, decodeURIComponent(relative.slice(12))),
            );
          if (!within(folder, path)) throw Error("Invalid review asset.");
          response.setHeader(
            "Content-Type",
            mime[extname(path)] ?? "application/octet-stream",
          );
          response.end(await readFile(path));
          return;
        }
        if (resource.document && relative === "__meta") {
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              format: resource.document.format,
              name: resource.document.name,
              line: resource.document.line,
              revision: resource.document.revision,
            }),
          );
          return;
        }
        if (resource.document && relative === "__annotations") {
          if (request.method !== "GET" || this.commentStreams.size >= 8)
            throw Error("The comment stream is unavailable.");
          response.setHeader("Content-Type", "text/event-stream");
          response.setHeader("Connection", "keep-alive");
          response.flushHeaders();
          this.commentStreams.set(response, resource);
          response.write(
            "data: " + JSON.stringify(this.commentData(resource)) + "\n\n",
          );
          const heartbeat = setInterval(() => {
            if (!response.destroyed) response.write(": keep-alive\n\n");
          }, 20000);
          heartbeat.unref();
          response.once("close", () => {
            clearInterval(heartbeat);
            this.commentStreams.delete(response);
          });
          return;
        }
        if (resource.document && relative === "__review") {
          if (
            request.method !== "POST" ||
            request.headers.origin !== this.origin
          )
            throw Error("Comments must originate in the open file viewer.");
          let body = "";
          for await (const chunk of request) {
            body += chunk.toString("utf8");
            if (Buffer.byteLength(body) > 18000)
              throw Error("This selection is too long.");
          }
          const input = JSON.parse(body),
            doc = resource.document;
          if (this.resource?.token !== resource.token || !this.visible)
            throw Error("This file is no longer open. Select it again.");
          if (
            input.action === "link" &&
            typeof input.href === "string" &&
            input.href.length <= 6000
          ) {
            this.emit("review:event", {
              action: "link",
              taskId: doc.taskId,
              href: input.href,
              basePath: doc.path,
            });
          } else if (
            input.action === "focus-comment" &&
            typeof input.commentId === "string" &&
            this.state().reviewComments?.some(
              (comment) =>
                comment.id === input.commentId && comment.taskId === doc.taskId,
            )
          ) {
            this.emit("review:event", {
              action: "focus-comment",
              taskId: doc.taskId,
              commentId: input.commentId,
            });
          } else if (input.action === "comment") {
            const selection = selectionSchema.parse(input.selection);
            this.emit("review:event", {
              action: "comment",
              reference: {
                ...selection,
                kind: doc.artifactId ? "artifact" : "file",
                taskId: doc.taskId,
                name: basename(doc.path),
                path: doc.path,
                artifactId: doc.artifactId,
                revision: doc.revision,
              },
            });
          } else throw Error("Unknown viewer action.");
          response.setHeader("Content-Type", "application/json");
          response.end('{"ok":true}');
          return;
        }
        if (
          resource.document &&
          (relative === "__document" || relative.startsWith("__asset/"))
        ) {
          if (!["GET", "HEAD"].includes(request.method ?? "GET"))
            throw Error("Saved documents are read-only.");
          const root = dirname(resource.document.path);
          const path =
            relative === "__document"
              ? await realpath(resource.document.path)
              : await realpath(
                  resolve(root, decodeURIComponent(relative.slice(8))),
                );
          if (!within(root, path))
            throw Error("Document asset is outside its artifact folder.");
          if (
            relative !== "__document" &&
            ![".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(
              extname(path).toLowerCase(),
            )
          )
            throw Error("Only local images can be embedded in a document.");
          const format = resource.document.format;
          const limit =
            relative !== "__document"
              ? 25_000_000
              : ["video", "audio"].includes(format)
                ? 4_000_000_000
                : format === "pdf"
                  ? 250_000_000
                  : 25_000_000;
          await streamArtifact(
            request,
            response,
            path,
            mime[extname(path).toLowerCase()] ?? "application/octet-stream",
            limit,
          );
          return;
        }
        if (resource.root) {
          if (!["GET", "HEAD"].includes(request.method ?? "GET"))
            throw new Error("Static previews are read-only.");
          const path = await realpath(
            resolve(
              resource.root,
              decodeURIComponent(relative || resource.entry!),
            ),
          );
          if (!within(resource.root, path))
            throw new Error("Preview path is outside the artifact folder.");
          if ((await stat(path)).size > 25_000_000)
            throw new Error(
              "This artifact is too large for a browser preview.",
            );
          response.setHeader(
            "Content-Type",
            mime[extname(path).toLowerCase()] ?? "application/octet-stream",
          );
          if (
            resource.document?.format === "html" &&
            path === resource.document.path &&
            request.method !== "HEAD"
          ) {
            const html = await readFile(path, "utf8"),
              ui = `<link rel="stylesheet" href="${prefix}__review-ui/html-annotations.css"><script type="module" src="${prefix}__review-ui/html-annotations.js"></script>`;
            response.end(
              /<\/body\s*>/i.test(html)
                ? html.replace(/<\/body\s*>/i, ui + "</body>")
                : html + ui,
            );
          } else
            response.end(
              request.method === "HEAD" ? undefined : await readFile(path),
            );
          return;
        }
        let target = localURL(
          new URL("/" + relative + url.search, resource.target!.origin).href,
        );
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 10_000_000)
            throw new Error("Preview request is too large.");
          chunks.push(chunk);
        }
        let upstream: Response | undefined;
        for (let count = 0; count < 6; count++) {
          upstream = await fetch(target, {
            method: request.method,
            body: ["GET", "HEAD"].includes(request.method ?? "GET")
              ? undefined
              : Buffer.concat(chunks),
            headers: request.headers["content-type"]
              ? { "content-type": request.headers["content-type"] }
              : undefined,
            redirect: "manual",
            signal: AbortSignal.timeout(20000),
          });
          if (
            upstream.status >= 300 &&
            upstream.status < 400 &&
            upstream.headers.get("location")
          ) {
            target = localURL(
              new URL(upstream.headers.get("location")!, target).href,
            );
            continue;
          }
          break;
        }
        if (!upstream) throw new Error("Local server returned no response.");
        response.statusCode = upstream.status;
        response.setHeader(
          "Content-Type",
          upstream.headers.get("content-type") ?? "text/html; charset=utf-8",
        );
        const body = Buffer.from(await upstream.arrayBuffer());
        if (body.length > 25_000_000)
          throw new Error("Local preview response is too large.");
        response.end(body);
      })().catch((error) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.statusCode = 400;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end(error.message);
        this.emit("preview:event", {
          url: "",
          title: "Preview needs attention",
          error: error.message,
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Local preview did not acquire a port.");
    this.origin = `http://127.0.0.1:${address.port}`;
  }
  async close(): Promise<void> {
    await this.hide().catch(() => {});
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
    this.server = undefined;
    this.listening = undefined;
    this.resources.clear();
    this.commentStreams.clear();
  }
}
