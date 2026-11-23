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
import {
  boardsCalls,
  boardsContract,
  boardsService,
} from "../runtime/sharing/memsync/boards-contract";
import {
  cardReaders,
  cardsCalls,
  cardsContract,
  cardsService,
  LARGEST_CARDS_MESSAGE,
} from "../runtime/sharing/memsync/cards-contract";
import { ownerCalls, ownerContract } from "./support/memsync-owner";

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

test("fields are written in the order of their numbers, however the shape lists them", () => {
  const listedBackwards = {
    Pair: {
      second: { number: 2, kind: "string" },
      first: { number: 1, kind: "string" },
    },
  } satisfies Contract;
  assert.equal(
    hex(encodeMessage(listedBackwards, "Pair", { second: "b", first: "a" })),
    "0a0161" + "120162",
  );
});

/**
 * Reads the messages, enums and calls out of a .proto file that has no nested messages.
 * A field of an enum type travels as an int32, so it is read as one.
 */
function parseProto(source: string) {
  const text = source.replace(/\/\/[^\n]*/g, "");
  const enums: Record<string, Record<string, number>> = {};
  for (const [, name, body] of text.matchAll(/enum\s+(\w+)\s*\{([^{}]*)\}/g))
    enums[name] = Object.fromEntries(
      [...body.matchAll(/(\w+)\s*=\s*(\d+)\s*;/g)].map(([, value, number]) => [
        value,
        Number(number),
      ]),
    );
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
        kind: kind in enums ? "int32" : kind,
        repeated: !!repeated,
      };
  }
  const calls: Record<string, { request: string; reply: string }> = {};
  for (const [, name, request, reply] of text.matchAll(
    /rpc\s+(\w+)\s*\(\s*(\w+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?(\w+)\s*\)/g,
  ))
    calls[name] = { request, reply };
  return {
    package: /package\s+([\w.]+)\s*;/.exec(text)?.[1],
    service: /service\s+(\w+)/.exec(text)?.[1],
    enums,
    messages,
    calls,
  };
}

/** The shapes written by hand, as the .proto file would state them. */
const written = (shapes: Contract) =>
  Object.fromEntries(
    Object.entries(shapes)
      .filter(([name]) => !name.startsWith("google.protobuf."))
      .map(([name, shape]) => [
        name,
        Object.fromEntries(
          Object.entries(shape).map(([field, stated]) => [
            field,
            {
              number: stated.number,
              kind:
                typeof stated.kind === "string"
                  ? stated.kind
                  : stated.kind.message,
              repeated: "repeated" in stated && !!stated.repeated,
            },
          ]),
        ),
      ]),
  );
const contractIn = async (file: string) =>
  parseProto(
    await readFile(
      new URL(`../runtime/sharing/memsync/${file}`, import.meta.url),
      "utf8",
    ),
  );

test("what MemCode reads and writes of projects is what the contract says", async () => {
  const contract = await contractIn("projects.proto");
  assert.equal(`${contract.package}.${contract.service}`, projectsService);
  // The owner's calls are used by tests only, and are held to the contract all the same.
  for (const [name, call] of Object.entries(ownerCalls))
    assert.deepEqual(contract.calls[name], call, `call ${name}`);
  for (const [name, shape] of Object.entries(written(ownerContract)))
    assert.deepEqual(shape, contract.messages[name], `message ${name}`);
  for (const call of Object.values(projectsCalls))
    for (const used of [call.request, call.reply])
      assert.ok((projectsContract as Contract)[used], `no shape for ${used}`);
});

test("what MemCode reads and writes of a board's log is what the contract says", async () => {
  const contract = await contractIn("boards.proto");
  assert.equal(`${contract.package}.${contract.service}`, boardsService);
  // A watched log answers with a stream, which the contract marks and the shape does not.
  assert.deepEqual(
    Object.keys(contract.calls).sort(),
    Object.keys(boardsCalls).sort(),
  );
  for (const [name, call] of Object.entries(boardsCalls))
    assert.deepEqual(contract.calls[name], call, `call ${name}`);
  assert.deepEqual(written(boardsContract), contract.messages);
});

test("what MemCode reads and writes of a card's log and its files is what the contract says", async () => {
  const contract = await contractIn("cards.proto");
  const boards = await contractIn("boards.proto");
  assert.equal(`${contract.package}.${contract.service}`, cardsService);
  assert.deepEqual(
    Object.keys(contract.calls).sort(),
    Object.keys(cardsCalls).sort(),
  );
  for (const [name, call] of Object.entries(cardsCalls))
    assert.deepEqual(contract.calls[name], call, `call ${name}`);
  // A receipt is the board log's own, imported by cards.proto.
  assert.deepEqual(written(cardsContract), {
    ...contract.messages,
    UpdateReceipt: boards.messages.UpdateReceipt,
  });
  assert.deepEqual(contract.enums.Readers, {
    READERS_EVERYONE: cardReaders.everyone,
    READERS_ONLY_ITS_AUTHOR: cardReaders["only-its-author"],
  });
});

test("a file travels in one message, at the largest size the service allows", () => {
  const content = new Uint8Array(5 * 1024 * 1024).fill(7);
  const sent = encodeMessage(cardsContract, "DownloadFileResponse", {
    file: {
      sha256: "a".repeat(64),
      size: content.length,
      uploaded_by_account_id: "acct-1",
      uploaded_at: { seconds: 1795300000, nanos: 0 },
    },
    content,
  });
  assert.ok(sent.length <= LARGEST_CARDS_MESSAGE);
  const read = decodeMessage(cardsContract, "DownloadFileResponse", sent);
  assert.equal((read.content as Uint8Array).length, content.length);
});

test("a logged update travels with its bytes, its number and its time intact", () => {
  const payload = new Uint8Array([0, 1, 2, 250, 255, 0]);
  const logged = {
    id: "5f0c7a52-0b1f-4a43-8a3b-0c5d7e9f1a22",
    sequence: 4294967297,
    logged_at: { seconds: 1795300000, nanos: 5 },
    author_account_id: "acct-1",
    payload,
  };
  assert.deepEqual(
    decodeMessage(
      boardsContract,
      "BoardUpdate",
      encodeMessage(boardsContract, "BoardUpdate", logged),
    ),
    logged,
  );
});
