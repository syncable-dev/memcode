import test from "node:test";
import assert from "node:assert/strict";
import { ReviewAdmission } from "../runtime/review-admission";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(ready: () => boolean) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Admission did not reach the expected state.");
}

test("a writer-blocked epic does not hold capacity or prevent another epic's FIFO progress", async () => {
  let writing = true,
    implementations = 1;
  const admission = new ReviewAdmission(
    () => 3,
    () => implementations,
  );
  const held = gate(),
    entered: string[] = [],
    notes: string[] = [];
  const submit = (id: string, key: string, ready = () => true, hold = false) =>
    admission.submit({
      id,
      taskId: id,
      key,
      ready,
      waiting: (reason) => notes.push(`${id}:${reason}`),
      run: async () => {
        entered.push(id);
        if (hold) await held.promise;
      },
    });
  try {
    const a = submit("a", "epic-a", () => !writing),
      a2 = submit("a2", "epic-a"),
      b = submit("b", "epic-b", undefined, true),
      c = submit("c", "epic-c");
    await until(() => entered.includes("b") && entered.includes("c"));
    assert.deepEqual(entered, ["b", "c"]);
    assert.equal(admission.occupied(), 1);
    assert.ok(notes.includes("a:writers"));
    assert.ok(notes.includes("a2:epic"));
    writing = false;
    implementations = 0;
    admission.notify();
    await Promise.all([a, a2, c]);
    assert.deepEqual(entered, ["b", "c", "a", "a2"]);
    held.resolve();
    await b;
    await until(() => admission.occupied() === 0);
  } finally {
    held.resolve();
    admission.close();
  }
});

test("review permits share the implementation limit; cancellation and close release queued jobs without executing", async () => {
  let workers = 1,
    released = 0;
  const admission = new ReviewAdmission(
      () => 2,
      () => workers,
      () => {
        released++;
      },
    ),
    held = gate(),
    entered: string[] = [];
  const submit = (id: string, hold = false) =>
    admission.submit({
      id,
      key: id,
      taskId: id,
      ready: () => true,
      waiting: () => {},
      run: async () => {
        entered.push(id);
        if (hold) await held.promise;
      },
    });
  try {
    const first = submit("first", true),
      cancelled = submit("cancelled"),
      next = submit("next");
    await until(() => entered.length === 1);
    assert.equal(workers + admission.occupied(), 2);
    admission.cancel("cancelled");
    await cancelled;
    workers = 0;
    admission.notify();
    await next;
    assert.deepEqual(entered, ["first", "next"]);
    workers = 2;
    const closing = submit("closing");
    admission.close();
    await closing;
    assert.equal(entered.includes("closing"), false);
    held.resolve();
    await first;
    await until(() => admission.occupied() === 0);
    assert.equal(
      released,
      2,
      "Both actual releases wake queued implementation work",
    );
    await assert.rejects(submit("after-close"), /closing/);
  } finally {
    held.resolve();
    admission.close();
  }
});
