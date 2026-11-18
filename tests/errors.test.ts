import test from "node:test";
import assert from "node:assert/strict";
import {
  errorMessage,
  browserErrorMessage,
  analysisErrorMessage,
} from "../src/errors";

test("native string rejections remain visible to renderer actions", () => {
  assert.equal(
    errorMessage("External websites are not enabled."),
    "External websites are not enabled.",
  );
  assert.equal(
    errorMessage(new Error("Connection refused")),
    "Connection refused",
  );
  assert.equal(errorMessage({ message: "Story not found" }), "Story not found");
});

test("analysis failures keep the process owner and startup logs in technical details", () => {
  const locked =
    "MemDB store /Users/example/project/.memdb already has a memcore-server (pid 3454). Retry when its current owner releases the store.";
  const timeout =
    "MemDB port 50051 is held by Application (pid 3454, store /Users/example/other); this workspace is serving 127.0.0.1:51667 instead.\nmemcore-server did not become ready at http://127.0.0.1:51667: its log showed no start-up progress for 90s.";
  for (const detail of [
    locked,
    timeout + "\nstore locked by a previous instance",
  ]) {
    const { summary, details } = analysisErrorMessage(detail);
    assert.match(summary, /code index is in use by another process/);
    assert.equal(details, detail);
  }
  const stalled = analysisErrorMessage(timeout);
  assert.match(stalled.summary, /timed out/);
  assert.equal(stalled.details, timeout);
});

test("actionable short errors stay visible while long analysis output is available on demand", () => {
  const short = "The checkout changed. Retry on the selected branch.";
  assert.deepEqual(analysisErrorMessage(short), { summary: short });
  const diagnostic =
    "MCP error -32000: Connection closed\n" +
    "sample native startup log\n".repeat(100);
  const result = analysisErrorMessage("\u001b[31m" + diagnostic + "\u001b[0m");
  assert.equal(result.details, diagnostic.trim());
  assert.ok(result.summary.length < 90);
  assert.doesNotMatch(result.summary, /startup log|MCP error/);
});
test("failed local navigation explains the stopped server without terminal escape noise", () => {
  assert.equal(
    browserErrorMessage(
      "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5000/ Call log: \u001b[2m opening",
    ),
    "This server is not running. Start it in this card’s Terminal, then reload the page.",
  );
  assert.match(
    browserErrorMessage("net::ERR_NAME_NOT_RESOLVED"),
    /address could not be found/,
  );
});
