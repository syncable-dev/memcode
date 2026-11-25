import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { createRuntime } from "./app";
import type { AppState } from "../src/shared";
import { holdProfile } from "./profile-lock";
import { LatestWorkspacePublisher } from "./workspace-publisher";

const args = process.argv.slice(2),
  option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
const dataDir = resolve(
  option("--data-dir") ??
    process.env.MEMCODE_DATA_DIR ??
    join(process.env.APPDATA ?? process.cwd(), "MemCode"),
);
const appPath = resolve(option("--app-path") ?? process.cwd());
const traceTransport = process.env.MEMCODE_TRACE_TRANSPORT === "1";
let traceSequence = 0;
const traceWrite = (stage: string, sequence: number, value = 0) => {
  if (traceTransport)
    process.stderr.write(
      "[memcode-transport] " +
        JSON.stringify({ stage, at: Date.now(), sequence, value }) +
        "\n",
    );
};
const send = (value: unknown) => {
  const envelope = value as { kind?: string; event?: string };
  const traced = traceTransport && envelope.event === "workspace:state";
  const sequence = traced ? ++traceSequence : 0;
  if (traced) traceWrite("node-encode-start", sequence);
  const encoded =
    JSON.stringify(
      traced ? { ...envelope, transportSequence: sequence } : value,
    ) + "\n";
  if (traced)
    traceWrite("node-write-start", sequence, Buffer.byteLength(encoded));
  const accepted = process.stdout.write(encoded);
  if (traced)
    traceWrite("node-write-return", sequence, process.stdout.writableLength);
  return accepted;
};
if (traceTransport)
  process.stdout.on("drain", () => traceWrite("node-drain", traceSequence));
const workspacePublisher = new LatestWorkspacePublisher(
  {
    write: (payload) =>
      send({ kind: "event", event: "workspace:state", payload }),
    needsDrain: () => process.stdout.writableNeedDrain,
    onDrain: (listener) => {
      process.stdout.on("drain", listener);
      return () => process.stdout.off("drain", listener);
    },
  },
  {
    onError: (error) => console.error("Workspace notification failed:", error),
  },
);
console.log = (...args) =>
  process.stderr.write(
    args
      .map((value) =>
        typeof value === "string" ? value : JSON.stringify(value),
      )
      .join(" ") + "\n",
  );
let nextHost = 0,
  disconnected = false,
  closing = false;
const hostPending = new Map<
  string,
  { resolve: (value: any) => void; reject: (reason: Error) => void }
>();
const host = {
  call<T>(method: string, input: unknown = {}): Promise<T> {
    if (disconnected)
      return Promise.reject(new Error("The native host has closed."));
    const id = "host-" + ++nextHost;
    return new Promise<T>((resolve, reject) => {
      hostPending.set(id, { resolve, reject });
      send({ kind: "host_request", id, method, input });
    });
  },
};
let letGo: (() => Promise<void>) | undefined;
const ready = (async () => {
  letGo = await holdProfile(dataDir);
  const runtime = await createRuntime(
    dataDir,
    appPath,
    host,
    (event, payload) =>
      event === "workspace:state"
        ? workspacePublisher.publish(payload as AppState)
        : send({ kind: "event", event, payload }),
  );
  const openProject =
    option("--open-project") ?? process.env.MEMCODE_OPEN_PROJECT;
  if (openProject)
    await runtime.openProject(
      resolve(openProject),
      process.env.MEMCODE_OPEN_PROJECT_NAME,
      process.env.MEMCODE_OPEN_PROJECT_DESCRIPTION,
    );
  return runtime;
})();
ready.catch((error) =>
  process.stderr.write(`MemCode runtime could not start: ${error.message}\n`),
);
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    const app = await ready;
    await app.close();
    if (!disconnected) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          workspacePublisher.flush(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(new Error("Workspace notification drain timed out.")),
              3000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
  } catch (error) {
    process.stderr.write(`Runtime shutdown: ${(error as Error).message}\n`);
  } finally {
    workspacePublisher.dispose();
    await letGo?.();
    letGo = undefined;
  }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  void (async () => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.kind === "host_response") {
      const pending = hostPending.get(message.id);
      if (!pending) return;
      hostPending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (
      message.kind !== "request" ||
      typeof message.id !== "string" ||
      typeof message.method !== "string"
    )
      return;
    try {
      if (message.method === "runtime:shutdown") {
        await shutdown();
        send({ kind: "response", id: message.id, result: null });
        setImmediate(() => process.exit(0));
        return;
      }
      if (closing) throw new Error("The workspace is closing.");
      const app = await ready;
      const result = await app.request(message.method, message.input);
      send({ kind: "response", id: message.id, result: result ?? null });
    } catch (error) {
      send({
        kind: "response",
        id: message.id,
        error: (error as Error).message,
      });
    }
  })().catch((error) => process.stderr.write(String(error) + "\n"));
});
input.on("close", () => {
  disconnected = true;
  for (const pending of hostPending.values())
    pending.reject(new Error("Native host disconnected."));
  hostPending.clear();
  void shutdown().finally(() => process.exit(0));
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    disconnected = true;
    for (const pending of hostPending.values())
      pending.reject(new Error("Native host is shutting down."));
    hostPending.clear();
    void shutdown().finally(() => process.exit(0));
  });
