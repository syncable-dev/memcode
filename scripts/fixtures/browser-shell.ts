// Stands in for the three @tauri-apps/api modules when the app window runs in an
// ordinary browser beside scripts/shared-projects-local.mts. Requests go to that
// script over HTTP instead of to the native shell.
type Listener = (event: { payload: unknown }) => void;

const listeners = new Map<string, Set<Listener>>();
let showWorkspace: ((state: unknown) => void) | undefined;
let events: EventSource | undefined;

function listenToRuntime() {
  if (events) return;
  events = new EventSource("/events");
  events.onmessage = (message) => {
    const { event, payload } = JSON.parse(message.data);
    if (event === "workspace:state") showWorkspace?.(payload);
    else listeners.get(event)?.forEach((listener) => listener({ payload }));
  };
}

async function rpc(method: string, input: unknown): Promise<unknown> {
  const response = await fetch("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, input }),
  });
  const reply = await response.json();
  // The native shell rejects with a string, and src/tauri.ts expects that.
  if (reply.error !== undefined) throw reply.error;
  return reply.result;
}

export const isTauri = () => true;

export class Channel<T> {
  onmessage: (message: T) => void = () => {};
}

export async function invoke<T>(command: string, args: any = {}): Promise<T> {
  if (command === "rpc") return rpc(args.method, args.input) as Promise<T>;
  if (command === "workspace_ack") return true as T;
  if (command !== "workspace_connect") throw `Unknown command ${command}`;
  let sequence = 0;
  showWorkspace = (state) =>
    args.channel.onmessage({ sequence: ++sequence, token: args.token, state });
  listenToRuntime();
  const loaded = (await rpc("workspace:load", null)) as { state: unknown };
  showWorkspace(loaded.state);
  return undefined as T;
}

export async function listen(event: string, listener: Listener) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(listener);
  listenToRuntime();
  return () => void listeners.get(event)!.delete(listener);
}

export const getCurrentWindow = () => ({ startDragging: async () => {} });
