import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  BETA_PROGRAM,
  BETA_TERMS,
  type BetaPublicKey,
} from "../../runtime/beta-auth";
import type { BetaCredentials, BetaStoredState } from "../../runtime/beta";

const encoded = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * What the native credential store holds for someone who is signed in to the
 * beta: their session and a current engine proof, signed by a key made here.
 */
export function signedInBetaStore(
  account: { id: string; name: string; email?: string },
  accessFile: string,
): BetaStoredState {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = {
    ...pair.publicKey.export({ format: "jwk" }),
    kid: "memcode-test-session",
    alg: "EdDSA",
    use: "sig",
  } as BetaPublicKey;
  const deviceId = "device-" + randomBytes(12).toString("hex"),
    sessionId = "session-" + randomBytes(12).toString("hex"),
    issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = [
    encoded({ alg: "EdDSA", typ: "JWT", kid: publicKey.kid }),
    encoded({
      iss: "https://memtrace.io",
      aud: "memcode-engine-beta",
      purpose: "memcode-engine-beta",
      program: BETA_PROGRAM,
      sub: account.id,
      name: account.name,
      ...(account.email ? { email: account.email } : {}),
      device_id: deviceId,
      session_id: sessionId,
      terms_version: BETA_TERMS,
      entitlements: {
        local_engine: true,
        graph_queries: "unlimited",
        cortex: true,
        improve: true,
        external_memdb: false,
        provider_credits: false,
      },
      iat: issuedAt,
      exp: issuedAt + 900,
      jti: randomBytes(32).toString("base64url"),
    }),
  ].join(".");
  const credentials: BetaCredentials = {
    version: 1,
    deviceId,
    sessionId,
    refreshToken: randomBytes(32).toString("base64url"),
    refreshExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    account,
    termsVersion: BETA_TERMS,
    publicKey,
    accessExpiresAt: new Date((issuedAt + 900) * 1000).toISOString(),
  };
  return {
    configured: true,
    credentials,
    accessToken: `${unsigned}.${sign(null, Buffer.from(unsigned), pair.privateKey).toString("base64url")}`,
    accessFile,
  };
}
