// Runs the real MemCode runtime and the real app window in a browser, signed in
// through a memtrace.io you run on this computer, so sharing can be tried before
// anything is deployed. docs/shared-projects.md has the steps.
//
// What is real: the runtime, its beta sign-in and refresh, the token exchange,
// the gRPC calls to memsync-server and every pixel of the app.
// What stands in: the native shell (this script answers its calls), the person
// in the browser (the script approves the sign-in with the cookie you give it),
// and the code engine, which is switched off.
//
//   MEMCODE_LOCAL_SITE=http://127.0.0.1:3000 \
//   MEMCODE_LOCAL_SITE_COOKIE=<better-auth.session_token of a signed-in person> \
//   node --import tsx scripts/shared-projects-local.mts [--port 5310] [--profile <folder>]
//     [--stand-in-worker]
//
// --stand-in-worker adds POST /dev/worker-turn, which plays a worker on a task:
// it adds a turn of the conversation, sets the run's state and can save a file
// the worker made. It also answers follow-ups: one sent to a task, here or from
// another computer, is picked up and answered in a couple of seconds, in place
// of a real worker. Nothing runs a model. Everything else in the app is as it is.
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../runtime/app.ts";
import { BETA_ORIGIN } from "../runtime/beta-auth.ts";
import { ManagedMemcodeEngine } from "../runtime/managed-engine.ts";
import { MemtraceEngine } from "../runtime/memtrace.ts";
import { initialState } from "../src/seed.ts";
import { WorkerManager } from "../runtime/workers.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const option = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const site = new URL(process.env.MEMCODE_LOCAL_SITE ?? "");
const cookie = process.env.MEMCODE_LOCAL_SITE_COOKIE;
if (!["localhost", "127.0.0.1", "[::1]"].includes(site.hostname) || !cookie)
  throw new Error(
    "Set MEMCODE_LOCAL_SITE to a memtrace.io on this computer and MEMCODE_LOCAL_SITE_COOKIE to a signed-in person's session cookie.",
  );
const port = Number(option("--port") ?? 5310);
const profile = resolve(
  option("--profile") ??
    (await mkdtemp(join(tmpdir(), "memcode-local-profile-"))),
);
const built = join(profile, "window");

// MemCode only ever signs in at memtrace.io. Here, and only here, that name leads to the local site.
const sendToInternet = globalThis.fetch;
const sendToLocalSite: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== BETA_ORIGIN) return sendToInternet(input, init);
  return sendToInternet(new URL(url.pathname + url.search, site), init);
};
globalThis.fetch = sendToLocalSite;

// No code engine in this run: nothing is downloaded and no installed Memtrace is touched.
ManagedMemcodeEngine.prototype.prepare = async () => join(profile, "no-engine");
MemtraceEngine.prototype.analyze = async () => {
  throw new Error("The code engine is switched off in this local run.");
};

/** The person in the browser, approving MemCode's sign-in at the local site. */
async function approveSignIn(authorizeUrl: string) {
  const signedIn = { cookie: `better-auth.session_token=${cookie}` };
  const page = await sendToLocalSite(authorizeUrl, { headers: signedIn });
  const consent = /name="consent" value="([^"]+)"/.exec(await page.text())?.[1];
  if (!consent)
    throw new Error(
      `The local site showed no approval page (HTTP ${page.status}). Is the cookie for a signed-in, approved person?`,
    );
  const approved = await sendToLocalSite(
    new URL("/api/memcode/beta/authorize", BETA_ORIGIN),
    {
      method: "POST",
      redirect: "manual",
      headers: {
        ...signedIn,
        origin: BETA_ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        consent,
        action: "approve",
        accept_terms: "yes",
      }),
    },
  );
  const backToMemcode = approved.headers.get("location");
  if (!backToMemcode)
    throw new Error(
      `The local site did not approve (HTTP ${approved.status}).`,
    );
  await sendToInternet(backToMemcode);
}

/** The native shell's part: the credential store, and the pages it would open in a browser. */
const stored: {
  configured: boolean;
  signedOut?: boolean;
  credentials: unknown;
  accessToken?: string;
} = {
  configured: false,
  credentials: null,
};
const accessFile = join(profile, "engine-access.jwt");
const host = {
  async call<T>(method: string, input?: any): Promise<T> {
    const done = null as T;
    if (method === "beta_store_read")
      return structuredClone({
        ...stored,
        ...(stored.accessToken ? { accessFile } : {}),
      }) as T;
    if (method === "beta_store_write") {
      Object.assign(stored, {
        configured: true,
        signedOut: false,
        credentials: input.credentials,
      });
      return done;
    }
    if (method === "beta_access_write") {
      stored.accessToken = input.accessToken;
      await writeFile(accessFile, input.accessToken, { mode: 0o600 });
      return { accessFile } as T;
    }
    if (method === "beta_access_clear")
      return void (stored.accessToken = undefined) as T;
    if (method === "beta_store_mark_signed_out")
      return void Object.assign(stored, {
        signedOut: true,
        accessToken: undefined,
      }) as T;
    if (method === "beta_store_forget_session" || method === "beta_store_clear")
      return void Object.assign(stored, {
        credentials: null,
        accessToken: undefined,
      }) as T;
    if (method === "open_memcode_beta") {
      // The shell returns at once and the browser does its part afterwards.
      void approveSignIn(input.url).catch((problem) =>
        console.error(String(problem)),
      );
      return done;
    }
    if (method === "installation_status")
      return {
        state: "development",
        needsInstall: false,
        canUpdate: false,
      } as T;
    console.log(
      `[shell] ${method}${method.startsWith("open_") ? " would open a page or folder" : ""}`,
    );
    return done;
  },
};

// A workspace with one project of its own, so there is something to connect.
await mkdir(join(profile, "website"), { recursive: true });
try {
  await readFile(join(profile, "workspace.json"));
} catch {
  const state = initialState();
  state.projects.push({
    id: "local-website",
    name: "website",
    description: "A local project for trying out sharing.",
    path: join(profile, "website"),
    branch: "main",
    analysis: "idle",
    createdAt: new Date().toISOString(),
  });
  state.activeProjectId = "local-website";
  await writeFile(join(profile, "workspace.json"), JSON.stringify(state));
}

const watchers = new Set<(event: string, payload: unknown) => void>();
const runtime = await createRuntime(profile, root, host, (event, payload) =>
  watchers.forEach((tell) => tell(event, payload)),
);

// The app's own code, with the three Tauri modules replaced by ones that talk to this script.
await build({
  configFile: false,
  root,
  base: "./",
  plugins: [react()],
  logLevel: "warn",
  resolve: {
    alias: Object.fromEntries(
      ["core", "event", "window"].map((part) => [
        `@tauri-apps/api/${part}`,
        join(root, "scripts/fixtures/browser-shell.ts"),
      ]),
    ),
  },
  build: { outDir: built, emptyOutDir: true, target: "es2023" },
});

/** A worker's turn, played without a model, for trying card activity in two windows. */
async function playWorker(turn: {
  taskId: string;
  role?: "user" | "assistant";
  text?: string;
  state?: "running" | "finished";
  file?: { name: string; text: string };
}) {
  const state = runtime.store.state;
  const task = state.tasks.find((item) => item.id === turn.taskId);
  if (!task) throw new Error("No such task here.");
  const now = new Date().toISOString();
  if (!task.run.startedAt) task.run = { state: "running", startedAt: now };
  if (turn.state) task.run.state = turn.state;
  if (turn.state === "finished") task.run.finishedAt = now;
  task.run.activity =
    turn.state === "finished"
      ? undefined
      : ({
          phase: "editing",
          label: "Editing project files",
          at: now,
        } as never);
  if (turn.text)
    task.messages.push({
      id: randomUUID(),
      role: turn.role ?? "assistant",
      text: turn.text,
      at: now,
    });
  if (turn.file) {
    const folder = join(profile, "captures", task.id);
    await mkdir(folder, { recursive: true });
    const path = join(folder, turn.file.name);
    await writeFile(path, turn.file.text);
    state.artifacts.push({
      id: randomUUID(),
      projectId: task.projectId,
      taskId: task.id,
      name: turn.file.name,
      kind: turn.file.name.endsWith(".html") ? "html" : "text",
      path,
      createdAt: now,
      source: "Worker",
      purpose: "report",
    });
  }
  // Saved as any change is, so sharing hears of it.
  await runtime.request("task:update", { id: task.id, patch: {} });
}

/**
 * In place of a real worker: a follow-up that waits on a task is picked up, and
 * a moment later answered. The run keeps its start, so its card shows one run.
 */
const standInWorker = process.argv.includes("--stand-in-worker");
const ANSWER_AFTER_MS = 2500;
function answerFollowups() {
  const state = runtime.store.state;
  for (const task of state.tasks) {
    const waiting = task.messages.filter(
      (message) => message.followupState === "queued" && !message.promptedAt,
    );
    if (!waiting.length) continue;
    const now = new Date().toISOString();
    for (const message of waiting) {
      message.promptedAt = now;
      message.followupState = "included";
    }
    task.run = {
      ...task.run,
      state: "running",
      startedAt: task.run.startedAt ?? now,
      finishedAt: undefined,
      activity: { phase: "editing", label: "Editing project files", at: now },
    } as typeof task.run;
    void runtime.request("task:update", { id: task.id, patch: {} });
    setTimeout(() => {
      void playWorker({
        taskId: task.id,
        text: waiting
          .map(
            (message) =>
              `Done with “${message.text.split("\n")[0].slice(0, 120)}” (the local stand-in worker answered; no model ran).`,
          )
          .join("\n\n"),
        state: "finished",
      }).catch((problem) => console.error("The stand-in worker failed:", problem));
    }, ANSWER_AFTER_MS);
  }
}
if (standInWorker)
  WorkerManager.prototype.dispatchQueued = function () {
    queueMicrotask(answerFollowups);
  };

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
const origin = `http://127.0.0.1:${port}`;
createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", origin);
  // Only this page may drive the runtime: no other site, and no request without JSON.
  const fromHere =
    request.headers.host === `127.0.0.1:${port}` &&
    (request.headers.origin ?? origin) === origin;
  if (!fromHere) return void response.writeHead(403).end();
  if (request.method === "POST" && url.pathname === "/rpc") {
    let body = "";
    for await (const part of request) body += part;
    const reply = await (async () => {
      if (
        !String(request.headers["content-type"]).startsWith("application/json")
      )
        return { error: "Send JSON." };
      try {
        const { method, input } = JSON.parse(body);
        return {
          result: (await runtime.request(method, input ?? null)) ?? null,
        };
      } catch (problem) {
        return { error: (problem as Error).message };
      }
    })();
    response.writeHead(200, { "content-type": "application/json" });
    return void response.end(JSON.stringify(reply));
  }
  if (
    process.argv.includes("--stand-in-worker") &&
    request.method === "POST" &&
    url.pathname === "/dev/worker-turn"
  ) {
    let body = "";
    for await (const part of request) body += part;
    try {
      await playWorker(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      return void response.end("{}");
    } catch (problem) {
      response.writeHead(400, { "content-type": "application/json" });
      return void response.end(
        JSON.stringify({ error: (problem as Error).message }),
      );
    }
  }
  if (url.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    const tell = (event: string, payload: unknown) =>
      response.write(`data: ${JSON.stringify({ event, payload })}\n\n`);
    watchers.add(tell);
    return void request.on("close", () => watchers.delete(tell));
  }
  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  try {
    const file = resolve(built, name);
    if (!file.startsWith(built)) throw new Error("outside the built window");
    const bytes = await readFile(file);
    response.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () =>
  console.log(
    `MemCode is at ${origin}\n  profile: ${profile}\n  signs in at: ${site.origin} (stands in for ${BETA_ORIGIN})\n` +
      `  finds sharing in: ${new URL("/api/memcode/services", site).href}`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void runtime.close().finally(() => process.exit(0)));
