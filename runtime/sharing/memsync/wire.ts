/**
 * Protocol Buffers (proto3) on the wire, for the kinds of field the sharing
 * service's contract uses. A message is described by its shape, so the shapes
 * can be checked against the .proto file in a test.
 */
export type ScalarKind =
  "string" | "bytes" | "uint32" | "uint64" | "int32" | "int64";
/** Only messages are repeated in the contract, so only they can be. */
export type FieldShape =
  | { number: number; kind: ScalarKind }
  | { number: number; kind: { message: string }; repeated?: boolean };
export type MessageShape = Record<string, FieldShape>;
/** Message shapes by name. */
export type Contract = Record<string, MessageShape>;
export type WireValue =
  string | number | Uint8Array | WireMessage | WireMessage[];
export interface WireMessage {
  [field: string]: WireValue | undefined;
}

/** Bytes that are not the message they were said to be, or a value that cannot be sent. */
export class WireError extends Error {}

const VARINT = 0,
  FIXED64 = 1,
  LENGTH_DELIMITED = 2,
  FIXED32 = 5;
const WIRE_TYPE_BITS = 3,
  LONGEST_VARINT = 10,
  TWO_TO_64 = 1n << 64n;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const ranges = {
  uint32: [0, 4294967295],
  uint64: [0, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
} as const;
type NumberKind = keyof typeof ranges;
const isNumberKind = (kind: FieldShape["kind"]): kind is NumberKind =>
  typeof kind === "string" && kind in ranges;
const isRepeated = (field: FieldShape) =>
  "repeated" in field && !!field.repeated;

function shapeOf(contract: Contract, name: string): MessageShape {
  const shape = contract[name];
  if (!shape) throw new WireError(`No shape is known for ${name}.`);
  return shape;
}

class Writer {
  private readonly parts: Uint8Array[] = [];
  private varint(value: bigint) {
    const bytes: number[] = [];
    let rest = value;
    do {
      const low = Number(rest & 0x7fn);
      rest >>= 7n;
      bytes.push(rest ? low | 0x80 : low);
    } while (rest);
    this.parts.push(Uint8Array.from(bytes));
  }
  private tag(field: number, wireType: number) {
    this.varint(BigInt((field << WIRE_TYPE_BITS) | wireType));
  }
  number(field: number, value: number) {
    this.tag(field, VARINT);
    // A negative number travels as its 64-bit two's complement.
    this.varint(value < 0 ? TWO_TO_64 + BigInt(value) : BigInt(value));
  }
  bytes(field: number, value: Uint8Array) {
    this.tag(field, LENGTH_DELIMITED);
    this.varint(BigInt(value.length));
    this.parts.push(value);
  }
  finish(): Uint8Array {
    return new Uint8Array(Buffer.concat(this.parts));
  }
}

function checkedNumber(
  kind: NumberKind,
  value: unknown,
  field: string,
): number {
  const [least, most] = ranges[kind];
  if (
    !Number.isInteger(value) ||
    (value as number) < least ||
    (value as number) > most
  )
    throw new WireError(`${field} is not a ${kind}.`);
  return value as number;
}

function writeField(
  writer: Writer,
  contract: Contract,
  name: string,
  { number, kind }: FieldShape,
  value: WireValue,
) {
  if (typeof kind !== "string") {
    if (
      typeof value !== "object" ||
      value instanceof Uint8Array ||
      Array.isArray(value)
    )
      throw new WireError(`${name} is not a message.`);
    writer.bytes(number, encodeMessage(contract, kind.message, value));
  } else if (isNumberKind(kind)) {
    if (checkedNumber(kind, value, name) !== 0)
      writer.number(number, value as number);
  } else if (kind === "string") {
    if (typeof value !== "string") throw new WireError(`${name} is not text.`);
    if (value) writer.bytes(number, new TextEncoder().encode(value));
  } else {
    if (!(value instanceof Uint8Array))
      throw new WireError(`${name} is not bytes.`);
    if (value.length) writer.bytes(number, value);
  }
}

/** Writes a message as the reference implementation does: fields by number, defaults left out. */
export function encodeMessage(
  contract: Contract,
  message: string,
  value: WireMessage,
): Uint8Array {
  const writer = new Writer();
  const fields = Object.entries(shapeOf(contract, message)).sort(
    ([, left], [, right]) => left.number - right.number,
  );
  for (const [name, shape] of fields) {
    const given = value[name];
    if (given === undefined) continue;
    if (!isRepeated(shape)) writeField(writer, contract, name, shape, given);
    else if (!Array.isArray(given))
      throw new WireError(`${name} is not a list.`);
    else
      for (const item of given) writeField(writer, contract, name, shape, item);
  }
  return writer.finish();
}

class Reader {
  private at = 0;
  constructor(private readonly source: Uint8Array) {}
  get done() {
    return this.at >= this.source.length;
  }
  varint(): bigint {
    let value = 0n;
    for (let read = 0; read < LONGEST_VARINT; read++) {
      if (this.done) throw new WireError("The message ends inside a number.");
      const byte = this.source[this.at++];
      value |= BigInt(byte & 0x7f) << BigInt(7 * read);
      if (!(byte & 0x80)) return BigInt.asUintN(64, value);
    }
    throw new WireError("A number in the message never ends.");
  }
  take(length: number): Uint8Array {
    if (length > this.source.length - this.at)
      throw new WireError("The message ends inside a field.");
    const taken = this.source.subarray(this.at, this.at + length);
    this.at += length;
    return taken;
  }
  delimited(): Uint8Array {
    const length = this.varint();
    if (length > BigInt(this.source.length))
      throw new WireError("The message ends inside a field.");
    return this.take(Number(length));
  }
  skip(wireType: number) {
    if (wireType === VARINT) this.varint();
    else if (wireType === FIXED64) this.take(8);
    else if (wireType === LENGTH_DELIMITED) this.delimited();
    else if (wireType === FIXED32) this.take(4);
    else
      throw new WireError(
        "The message has a field of a kind proto3 does not have.",
      );
  }
}

function numberRead(kind: NumberKind, raw: bigint, field: string): number {
  const value =
    kind === "int32" || kind === "int64" ? BigInt.asIntN(64, raw) : raw;
  const [least, most] = ranges[kind];
  if (value < BigInt(least) || value > BigInt(most))
    throw new WireError(`${field} is out of range for a ${kind}.`);
  return Number(value);
}

function readField(
  reader: Reader,
  contract: Contract,
  name: string,
  { kind }: FieldShape,
  wireType: number,
): WireValue {
  const expected = isNumberKind(kind) ? VARINT : LENGTH_DELIMITED;
  if (wireType !== expected)
    throw new WireError(`${name} was sent as another kind of field.`);
  if (isNumberKind(kind)) return numberRead(kind, reader.varint(), name);
  const bytes = reader.delimited();
  if (typeof kind !== "string")
    return decodeMessage(contract, kind.message, bytes);
  if (kind === "bytes") return new Uint8Array(bytes);
  try {
    return utf8.decode(bytes);
  } catch {
    throw new WireError(`${name} is not text.`);
  }
}

function emptyMessage(shape: MessageShape): WireMessage {
  const empty: WireMessage = {};
  for (const [name, field] of Object.entries(shape)) {
    const { kind } = field;
    if (isRepeated(field)) empty[name] = [];
    else if (kind === "string") empty[name] = "";
    else if (kind === "bytes") empty[name] = new Uint8Array();
    else if (isNumberKind(kind)) empty[name] = 0;
  }
  return empty;
}

/**
 * Reads a message. Fields that were not sent read as empty, a message that was
 * not sent is left out, and fields this shape does not know are skipped.
 * Throws WireError, and nothing else, for bytes that are not such a message.
 */
export function decodeMessage(
  contract: Contract,
  message: string,
  bytes: Uint8Array,
): WireMessage {
  const shape = shapeOf(contract, message);
  const byNumber = new Map(
    Object.entries(shape).map(([name, field]) => [
      field.number,
      { name, field },
    ]),
  );
  const read = emptyMessage(shape);
  const reader = new Reader(bytes);
  while (!reader.done) {
    const tag = reader.varint();
    const number = Number(tag >> BigInt(WIRE_TYPE_BITS)),
      wireType = Number(tag & 7n);
    if (number < 1)
      throw new WireError("The message has a field without a number.");
    const known = byNumber.get(number);
    if (!known) {
      reader.skip(wireType);
      continue;
    }
    const value = readField(
      reader,
      contract,
      known.name,
      known.field,
      wireType,
    );
    if (isRepeated(known.field))
      (read[known.name] as WireMessage[]).push(value as WireMessage);
    else read[known.name] = value;
  }
  return read;
}
