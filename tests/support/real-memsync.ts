import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  GrpcFailure,
  grpcChannel,
  grpcStatus,
} from "../../runtime/sharing/memsync/grpc";
import type { StandInPerson } from "./memsync-stand-in";
import type { SharingWorld } from "./projects-api-scenarios";

const BINARY = "MEMSYNC_SERVER_BINARY",
  DATABASE_SERVER = "MEMSYNC_TEST_DATABASE_URL",
  PSQL = "MEMSYNC_TEST_PSQL";
const ISSUER = "https://memtrace.io",
  AUDIENCE = "memsync",
  KEY_ID = "memcode-tests";

/** Why the tests against a real memsync-server cannot run here, or nothing when they can. */
export const realMemsyncMissing: string | false =
  process.env[BINARY] && process.env[DATABASE_SERVER]
    ? false
    : `set ${BINARY} to a built memsync-server and ${DATABASE_SERVER} to a PostgreSQL server where tests may create databases`;

const encoded = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export interface TokenChanges {
  claims?: Record<string, unknown>;
  /** Sign with a key the server was never told about. */
  unknownKey?: boolean;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function answers(address: URL): Promise<boolean> {
  const channel = grpcChannel(address);
  try {
    await channel.unary({
      path: "/memsync.v1.Projects/ListProjects",
      request: new Uint8Array(),
      timeoutMs: 1000,
    });
    return true;
  } catch (failure) {
    // Being asked who we are is an answer. Silence is not.
    return (
      failure instanceof GrpcFailure &&
      failure.code === grpcStatus.UNAUTHENTICATED
    );
  } finally {
    channel.close();
  }
}

/**
 * Starts the real `memsync-server` on a database of its own, trusting a signing key
 * made for this run. Stopping it drops the database, so nothing that was already
 * on the PostgreSQL server is touched.
 */
export async function startRealMemsync() {
  const psql = (sql: string) =>
    promisify(execFile)(process.env[PSQL] ?? "psql", [
      process.env[DATABASE_SERVER]!,
      "-v",
      "ON_ERROR_STOP=1",
      "-qAtc",
      sql,
    ]);
  const folder = await mkdtemp(join(tmpdir(), "memcode-real-memsync-"));
  const database = `memcode_test_${randomBytes(6).toString("hex")}`;
  const trusted = generateKeyPairSync("ed25519"),
    stranger = generateKeyPairSync("ed25519");
  const keyFile = join(folder, "keys.json");
  await writeFile(
    keyFile,
    JSON.stringify({
      keys: [
        {
          ...trusted.publicKey.export({ format: "jwk" }),
          kid: KEY_ID,
          alg: "EdDSA",
          use: "sig",
        },
      ],
    }),
  );
  await psql(`CREATE DATABASE "${database}"`);
  const databaseUrl = new URL(process.env[DATABASE_SERVER]!);
  databaseUrl.pathname = `/${database}`;
  const address = new URL(`http://127.0.0.1:${await freePort()}`);
  const output: string[] = [];
  const server = spawn(process.env[BINARY]!, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      MEMSYNC_DATABASE_URL: databaseUrl.href,
      MEMSYNC_TOKEN_ISSUER: ISSUER,
      MEMSYNC_TOKEN_AUDIENCE: AUDIENCE,
      MEMSYNC_TOKEN_KEYS_FILE: keyFile,
      MEMSYNC_LISTEN_ADDRESS: address.host,
    },
  });
  server.stdout.on("data", (part) => output.push(String(part)));
  server.stderr.on("data", (part) => output.push(String(part)));
  const exited = new Promise<void>((resolve) =>
    server.once("exit", () => resolve()),
  );
  const stop = async () => {
    server.kill("SIGTERM");
    await exited;
    await psql(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(
      () => {},
    );
    await rm(folder, { recursive: true, force: true });
  };
  const deadline = Date.now() + 20000;
  while (!(await answers(address))) {
    if (server.exitCode !== null || Date.now() > deadline) {
      await stop();
      throw new Error(`memsync-server did not start:\n${output.join("")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /** A token as memtrace.io issues it (MemSync's ADR-0010), signed for this run. */
  const tokenFor = (
    person: StandInPerson,
    changes: TokenChanges = {},
  ): string => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const unsigned = [
      encoded({ alg: "EdDSA", typ: "JWT", kid: KEY_ID }),
      encoded({
        iss: ISSUER,
        aud: AUDIENCE,
        purpose: "memsync-access",
        sub: person.accountId,
        name: person.name,
        ...(person.email ? { email: person.email } : {}),
        email_verified: !!person.email,
        iat: issuedAt,
        exp: issuedAt + 600,
        ...changes.claims,
      }),
    ].join(".");
    const key = changes.unknownKey ? stranger.privateKey : trusted.privateKey;
    return `${unsigned}.${sign(null, Buffer.from(unsigned), key).toString("base64url")}`;
  };
  return { address, tokenFor, stop };
}
export type RealMemsync = Awaited<ReturnType<typeof startRealMemsync>>;

/** One scenario's view of a server that all scenarios share. Their people never overlap. */
export const worldOn = (server: RealMemsync): SharingWorld => ({
  address: server.address,
  tokenFor: (person) => server.tokenFor(person),
  close: async () => {},
});

/** Why this memsync-server cannot run the Cards scenarios, or nothing when it can. */
export async function cardsMissing(
  server: RealMemsync,
): Promise<string | undefined> {
  const channel = grpcChannel(server.address);
  try {
    await channel.unary({
      path: "/memsync.v1.Cards/ReadCardEntries",
      request: new Uint8Array(),
      metadata: {
        authorization: `Bearer ${server.tokenFor({ accountId: "probe", name: "Probe" })}`,
      },
      timeoutMs: 2000,
    });
    return undefined;
  } catch (failure) {
    return failure instanceof GrpcFailure &&
      failure.code === grpcStatus.UNIMPLEMENTED
      ? "this memsync-server has no Cards service yet"
      : undefined;
  } finally {
    channel.close();
  }
}
