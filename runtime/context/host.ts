import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextBinding, GraphClient } from "./contracts";
import { ContextBroker } from "./broker";
import {
  terminalRequestSchema,
  type TerminalRequest,
  type TerminalReply,
} from "../../src/terminal";
import {
  browserRequestSchema,
  type BrowserRequest,
  type BrowserReply,
} from "../../src/browser";
import {
  discoverLocalModel,
  localAssistant,
  type RetrievalAssistant,
} from "./local-model";
import { discoverOnnxAssistant } from "./onnx";
import { OnnxAssistant } from "./onnx";
import {
  coordinationSchema,
  type CoordinationRequest,
} from "../fleet-requests";
import { runbookUpdateSchema, type RunbookUpdate } from "../../src/runbook";
import {
  contextAssistantDefaults,
  type ContextAssistantSettings,
} from "../../src/context-settings";

/** Adds what peers just did to a reply, in a form the worker reads whatever it asked for. */
function withFleetNews(result: unknown, news: unknown[]): unknown {
  if (!news.length) return result;
  if (result && typeof result === "object" && !Array.isArray(result))
    return { ...result, fleetNews: news };
  return { reply: result, fleetNews: news };
}
export interface ContextSession {
  endpoint: string;
  token: string;
  configPath: string;
  browserConfigPath?: string;
  close(): Promise<void>;
  broker: ContextBroker;
}
/** The worker gateway forwards three requests; graph clients and Fleet authority stay here. */
export async function startContextSession(
  engine: GraphClient,
  binding: ContextBinding,
  directory: string,
  options: {
    assistant?: RetrievalAssistant;
    discoverModel?: boolean;
    settings?: ContextAssistantSettings;
    browser?: (request: BrowserRequest) => Promise<BrowserReply>;
    coordination?: (request: CoordinationRequest) => Promise<unknown>;
    terminal?: (request: TerminalRequest) => Promise<TerminalReply>;
    runbook?: (update: RunbookUpdate) => Promise<string>;
    /** Fleet updates waiting for this worker; they ride along on whatever it asks next. */
    news?: () => unknown[];
  } = {},
): Promise<ContextSession> {
  await mkdir(directory, { recursive: true });
  let assistant = options.assistant;
  if (!assistant && options.settings?.enabled) {
    const settings = options.settings;
    if (
      settings.provider === "onnx" &&
      settings.model !== contextAssistantDefaults.model
    )
      throw new Error(
        `The ONNX pilot requires model ${contextAssistantDefaults.model}.`,
      );
    if (settings.provider === "onnx" && !settings.packageDirectory.trim())
      throw new Error("Set up the local retrieval assistant in Settings before enabling it.");
    assistant =
      settings.provider === "onnx"
        ? new OnnxAssistant(settings.packageDirectory)
        : localAssistant({ baseUrl: settings.baseUrl, model: settings.model });
  }
  if (!assistant && options.discoverModel) {
    const config = await discoverLocalModel();
    assistant = config
      ? localAssistant(config)
      : await discoverOnnxAssistant(binding.project.path!);
  }
  const broker = new ContextBroker(engine, binding, assistant, (record) =>
    appendFile(
      join(directory, "context-diagnostics.jsonl"),
      JSON.stringify(record) + "\n",
      { mode: 0o600 },
    ),
  );
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    const supplied = req.headers.authorization ?? "",
      expected = "Bearer " + token;
    if (
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      res.writeHead(401).end();
      return;
    }
    if (
      req.method !== "POST" ||
      (req.url !== "/context" && !(req.url === "/browser" && options.browser))
    ) {
      res.writeHead(404).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 96000)
          throw new Error("Worker request exceeds 96 KiB");
      }
      const input = JSON.parse(body);
      const result =
        req.url === "/browser"
          ? await options.browser!(browserRequestSchema.parse(input))
          : input.capability === "terminal" && options.terminal
            ? await options.terminal(
                terminalRequestSchema.parse(
                  Object.fromEntries(
                    Object.entries(input).filter(
                      ([key]) => key !== "capability",
                    ),
                  ),
                ),
              )
            : input.capability === "coordinate" && options.coordination
              ? await options.coordination(
                  coordinationSchema.parse(
                    Object.fromEntries(
                      Object.entries(input).filter(
                        ([key]) => key !== "capability",
                      ),
                    ),
                  ),
                )
              : input.capability === "runbook" && options.runbook
                ? await options.runbook(
                    runbookUpdateSchema.parse(
                      Object.fromEntries(
                        Object.entries(input).filter(
                          ([key]) => key !== "capability",
                        ),
                      ),
                    ),
                  )
                : await broker.execute(input);
      const fleetNews =
        req.url === "/context" && input.capability !== "coordinate"
          ? (options.news?.() ?? [])
          : [];
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        })
        .end(JSON.stringify(withFleetNews(result, fleetNews)));
    } catch (error) {
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Context host failed to bind loopback");
  const endpoint = `http://127.0.0.1:${address.port}/context`,
    configPath = join(directory, "context-session.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      endpoint,
      token,
      coordination: !!options.coordination,
      terminal: !!options.terminal,
      runbook: !!options.runbook,
    }),
    {
      mode: 0o600,
    },
  );
  const browserConfigPath = options.browser
    ? join(directory, "browser-session.json")
    : undefined;
  if (browserConfigPath)
    await writeFile(
      browserConfigPath,
      JSON.stringify({
        version: 1,
        kind: "browser",
        endpoint: endpoint.replace(/\/context$/, "/browser"),
        token,
      }),
      { mode: 0o600 },
    );
  let closing: Promise<void> | undefined;
  return {
    endpoint,
    token,
    configPath,
    browserConfigPath,
    broker,
    close: () =>
      (closing ??= (async () => {
        await assistant?.close?.();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      })()),
  };
}
