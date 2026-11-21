import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  decodeMessage,
  encodeMessage,
  WireError,
  type Contract,
} from "../runtime/sharing/memsync/wire";
import {
  projectsCalls,
  projectsContract,
  projectsService,
} from "../runtime/sharing/memsync/projects-contract";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "hex"));

// Made by the reference implementation, so MemCode's own encoder never checks itself:
//   protoc -I proto --encode=memsync.v1.Project memsync/v1/projects.proto
// from the text below (libprotoc 35.1, 21 November 2026).
const projectId = "0d3b6f0e-5a52-4c1e-9d3e-2f1f5f3a9c11",
  invitationId = "7a1c8a52-0b1f-4a43-8a3b-0c5d7e9f1a22";
const owner = {
  account_id: "acct-owner",
  name: "Alex Holm",
  email: "alex@example.com",
};
const project = {
  id: projectId,
  name: "Launch plan ✈",
  owner,
  guests: [
    { account_id: "acct-guest", name: "Bo Li", email: "" },
    {
      account_id: "acct-second",
      name: "Chidi Okafor",
      email: "chidi@example.com",
    },
  ],
  open_invitations: [
    {
      id: invitationId,
      project_id: projectId,
      project_name: "Launch plan ✈",
      email: "dana@example.com",
      invited_by: owner,
      sent_at: { seconds: 1795300000, nanos: 123456789 },
      expires_at: { seconds: 1796509600, nanos: 0 },
    },
  ],
  guest_limit: 2,
};
const projectFromProtoc =
  "0a2430643362366630652d356135322d346331652d396433652d326631663566336139633131120f4c61756e636820706c616e20e29c881a290a0a616363742d6f776e65721209416c657820486f6c6d1a10616c6578406578616d706c652e636f6d22130a0a616363742d67756573741205426f204c69222e0a0b616363742d7365636f6e64120c4368696469204f6b61666f721a116368696469406578616d706c652e636f6d2aaf010a2437613163386135322d306231662d346134332d386133622d306335643765396631613232122430643362366630652d356135322d346331652d396433652d3266316635663361396331311a0f4c61756e636820706c616e20e29c88221064616e61406578616d706c652e636f6d2a290a0a616363742d6f776e65721209416c657820486f6c6d1a10616c6578406578616d706c652e636f6d320b08a0b588d80610959aef3a3a0608a09fd2d8063002";
const acceptFromProtoc =
  "0a2430643362366630652d356135322d346331652d396433652d326631663566336139633131122437613163386135322d306231662d346134332d386133622d306335643765396631613232";

test("a project encoded by protoc is read field for field", () => {
  assert.deepEqual(
    decodeMessage(projectsContract, "Project", bytes(projectFromProtoc)),
    project,
  );
});

test("requests are written byte for byte as protoc writes them", () => {
  assert.equal(
    hex(
      encodeMessage(projectsContract, "AcceptInvitationRequest", {
        project_id: projectId,
        invitation_id: invitationId,
      }),
    ),
    acceptFromProtoc,
  );
  assert.equal(
    hex(encodeMessage(projectsContract, "Project", project)),
    projectFromProtoc,
  );
  assert.equal(
    hex(encodeMessage(projectsContract, "ListProjectsRequest", {})),
    "",
  );
});

test("fields that were not sent read as empty, and an absent message as absent", () => {
  assert.deepEqual(decodeMessage(projectsContract, "Project", bytes("")), {
    id: "",
    name: "",
    guests: [],
    open_invitations: [],
    guest_limit: 0,
  });
});

test("a field from a newer contract is skipped, whatever its kind", () => {
  const withUnknowns = bytes(
    "0a0161" + // id: "a"
      "7801" + // field 15, varint
      "8201026869" + // field 16, two bytes
      "8d0101000000" + // field 17, four fixed bytes
      "91010100000000000000" + // field 18, eight fixed bytes
      "3002", // guest_limit: 2
  );
  const read = decodeMessage(projectsContract, "Project", withUnknowns);
  assert.equal(read.id, "a");
  assert.equal(read.guest_limit, 2);
});

test("damaged bytes are refused with one kind of error and never crash", () => {
  const damaged = [
    "0a", // a length with nothing after it
    "0aff", // a string longer than the message
    "0a02c328", // a string that is not UTF-8
    "ffffffffffffffffffffff01", // a number that never ends
    "0800", // a number where the id's text belongs
    "32020800", // guest_limit sent as a nested message
    "1a05ffffffff0f", // an owner whose own bytes are cut short
    "0b", // a group, which proto3 no longer has
    "00", // field number zero
  ];
  for (const text of damaged)
    assert.throws(
      () => decodeMessage(projectsContract, "Project", bytes(text)),
      WireError,
      text,
    );
  const whole = bytes(projectFromProtoc);
  for (let cut = 0; cut < whole.length; cut++) {
    try {
      decodeMessage(projectsContract, "Project", whole.subarray(0, cut));
    } catch (error) {
      assert.ok(error instanceof WireError, `cut at ${cut}: ${error}`);
    }
  }
  for (let at = 0; at < whole.length; at++) {
    const flipped = Uint8Array.from(whole);
    flipped[at] ^= 0xff;
    try {
      decodeMessage(projectsContract, "Project", flipped);
    } catch (error) {
      assert.ok(error instanceof WireError, `flipped at ${at}: ${error}`);
    }
  }
});

test("numbers keep their value at the edges", () => {
  const numbers = {
    Numbers: {
      small: { number: 1, kind: "uint32" },
      large: { number: 2, kind: "uint64" },
      signed: { number: 3, kind: "int64" },
      short: { number: 4, kind: "int32" },
      raw: { number: 5, kind: "bytes" },
    },
  } satisfies Contract;
  for (const value of [
    {
      small: 4294967295,
      large: 9007199254740991,
      signed: -1,
      short: -2147483648,
    },
    { small: 1, large: 300, signed: -62135596800, short: 999999999 },
    { small: 127, large: 128, signed: 253402300799, short: -1 },
  ]) {
    const sent = { ...value, raw: new Uint8Array([0, 255, 7]) };
    assert.deepEqual(
      decodeMessage(
        numbers,
        "Numbers",
        encodeMessage(numbers, "Numbers", sent),
      ),
      sent,
    );
  }
  // 2^53 cannot be told from 2^53 + 1 in a JavaScript number.
  assert.throws(
    () => decodeMessage(numbers, "Numbers", bytes("1080808080808080" + "10")),
    WireError,
  );
  assert.throws(
    () => encodeMessage(numbers, "Numbers", { small: -1 }),
    WireError,
  );
  assert.throws(
    () => encodeMessage(numbers, "Numbers", { small: 1.5 }),
    WireError,
  );
});

/** Reads the messages and calls out of a .proto file that has no nested messages. */
function parseProto(source: string) {
  const text = source.replace(/\/\/[^\n]*/g, "");
  const messages: Record<
    string,
    Record<string, { number: number; kind: string; repeated: boolean }>
  > = {};
  for (const [, name, body] of text.matchAll(
    /message\s+(\w+)\s*\{([^{}]*)\}/g,
  )) {
    messages[name] = {};
    for (const [, repeated, kind, field, number] of body.matchAll(
      /(repeated\s+)?([\w.]+)\s+(\w+)\s*=\s*(\d+)\s*;/g,
    ))
      messages[name][field] = {
        number: Number(number),
        kind,
        repeated: !!repeated,
      };
  }
  const calls: Record<string, { request: string; reply: string }> = {};
  for (const [, name, request, reply] of text.matchAll(
    /rpc\s+(\w+)\s*\(\s*(\w+)\s*\)\s*returns\s*\(\s*(\w+)\s*\)/g,
  ))
    calls[name] = { request, reply };
  return {
    package: /package\s+([\w.]+)\s*;/.exec(text)?.[1],
    service: /service\s+(\w+)/.exec(text)?.[1],
    messages,
    calls,
  };
}

test("what MemCode reads and writes is what the contract says", async () => {
  const contract = parseProto(
    await readFile(
      new URL("../runtime/sharing/memsync/projects.proto", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(`${contract.package}.${contract.service}`, projectsService);
  for (const [name, call] of Object.entries(projectsCalls))
    assert.deepEqual(contract.calls[name], call, `call ${name}`);
  const shapes = projectsContract as Contract;
  for (const [name, shape] of Object.entries(shapes)) {
    if (name.startsWith("google.protobuf.")) continue;
    const written = Object.fromEntries(
      Object.entries(shape).map(([field, written]) => [
        field,
        {
          number: written.number,
          kind:
            typeof written.kind === "string"
              ? written.kind
              : written.kind.message,
          repeated: "repeated" in written && !!written.repeated,
        },
      ]),
    );
    assert.deepEqual(written, contract.messages[name], `message ${name}`);
  }
  // Every message a call uses is one MemCode has a shape for.
  for (const call of Object.values(projectsCalls))
    for (const used of [call.request, call.reply])
      assert.ok(shapes[used], `no shape for ${used}`);
});
