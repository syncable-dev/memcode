import type { Message } from "../../../src/shared";
import type { WorkerInputRequest } from "../../../src/worker-input";
import { publicText, type DeliveryRecord, type InputRecord } from "./entries";

/** Who runs the worker a message is for, in the words the sender reads. */
export interface Host {
  /** The person who started the worker. */
  name: string;
  /** "Mac", "Windows" or "Linux". */
  device: string;
  /** The worker runs under the account signed in here: the person's own other computer. */
  isYou: boolean;
}

const thereOf = (host: Host) =>
  host.isYou ? `your ${host.device}` : `${host.name}'s ${host.device}`;

/**
 * How a message sent to a worker on another computer stands, as its sender and
 * everyone else on the card read it. Only a delivery by the account that
 * started the worker is passed in.
 */
export function messageStanding(
  delivery: DeliveryRecord | undefined,
  host: Host,
  sending: boolean,
): Pick<Message, "followupState" | "deliveryLine" | "pickedUpAt"> {
  if (sending) return { followupState: "queued", deliveryLine: "Sending…" };
  switch (delivery?.state) {
    case undefined:
      return {
        followupState: "queued",
        deliveryLine: `Sent to ${thereOf(host)}`,
      };
    case "asking":
      return {
        followupState: "queued",
        deliveryLine: `Waiting for ${host.name} to allow it`,
      };
    case "queued":
      return {
        followupState: "queued",
        deliveryLine: host.isYou
          ? `Queued on your ${host.device}`
          : `${host.name} allowed it`,
      };
    case "picked-up":
      return { followupState: "included", pickedUpAt: delivery.at };
    case "declined":
      return {
        followupState: "cancelled",
        deliveryLine: `${host.name} declined`,
      };
    case "failed":
      return {
        followupState: "paused",
        deliveryLine: delivery.detail
          ? `Not delivered: ${delivery.detail}`
          : `Could not reach the worker on ${thereOf(host)}`,
      };
  }
}

/** Where an answer to what a worker waits for stands, for the panel that asked. */
export function answerStanding(
  delivery: DeliveryRecord | undefined,
  host: Host,
  sending: boolean,
): NonNullable<WorkerInputRequest["elsewhere"]> {
  const standing = messageStanding(delivery, host, sending);
  return {
    line:
      delivery?.state === "picked-up"
        ? `Answered from here`
        : standing.deliveryLine,
    // Declined or not delivered: the person may answer again.
    answerable: delivery?.state === "declined" || delivery?.state === "failed",
  };
}

const TITLE = 4000,
  TEXT = 8000;
const cut = (text: string | undefined, length: number) =>
  text === undefined ? undefined : publicText(text).slice(0, length);

/** What a worker run here waits for, as other computers may see it. */
export function inputRecordOf(
  input: WorkerInputRequest,
  sessionId: string,
): InputRecord {
  const secret = input.questions?.some((question) => question.secret);
  const record: InputRecord = {
    sessionId,
    id: input.id,
    kind: input.kind,
    title: cut(input.title, TITLE)!,
    description: cut(input.description, TEXT),
    toolName: input.toolName?.slice(0, 200),
    details: cut(input.details, TEXT),
    options: input.options?.slice(0, 40).map((option) => ({
      id: option.id.slice(0, 1000),
      label: option.label.slice(0, 500),
      ...(option.description
        ? { description: cut(option.description, 2000) }
        : {}),
      ...(option.kind ? { kind: option.kind } : {}),
    })),
    questions: input.questions?.slice(0, 20).map((question) => ({
      id: question.id.slice(0, 1000),
      question: cut(question.question, TITLE)!,
      options: question.options.slice(0, 40).map((option) => ({
        id: option.id.slice(0, 1000),
        label: option.label.slice(0, 500),
        ...(option.kind ? { kind: option.kind } : {}),
      })),
      ...(question.multiple ? { multiple: true } : {}),
      ...(question.allowText ? { allowText: true } : {}),
      ...(question.secret ? { secret: true } : {}),
    })),
    createdAt: input.createdAt,
    status: input.status,
    ...(secret ? { answerHere: true } : {}),
  };
  return JSON.parse(JSON.stringify(record));
}

/** One line for an answer, for the person asked to allow it. */
export function answerSummary(
  input: WorkerInputRequest | undefined,
  response: { optionId?: string; answers?: Record<string, string | string[]> },
): string {
  if (!input) return "An answer to what the worker asked";
  const chosen = input.options?.find(
    (option) => option.id === response.optionId,
  );
  if (chosen) return `${input.title}: ${chosen.label}`;
  const answers = (input.questions ?? []).map((question) => {
    const value = response.answers?.[question.id];
    const labels = (Array.isArray(value) ? value : [value ?? ""]).map(
      (one) =>
        question.options.find((option) => option.id === one)?.label ?? one,
    );
    return `${question.question}: ${labels.join(", ")}`;
  });
  return answers.length ? answers.join("\n") : input.title;
}
