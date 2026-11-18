export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return "The request could not be completed. Please try again.";
}
export function browserErrorMessage(error: unknown) {
  const message = errorMessage(error).replace(/\x1b\[[0-9;]*m/g, "");
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(message))
    return "This server is not running. Start it in this card’s Terminal, then reload the page.";
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(message))
    return "This address could not be found. Check the address and try again.";
  if (
    /page\.goto.*Timeout|Navigation.*timed out|Timeout .*exceeded/.test(message)
  )
    return "The page took too long to respond. Check the server or reload the page.";
  return message.split("Call log:")[0].trim();
}

export function analysisErrorMessage(error: string) {
  const details = error.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (
    /MemDB store [^\r\n]*already has a memcore-server|store (?:is )?locked by a previous instance|another memcore-server still holds|timed out waiting for store-scope lock|another memtrace daemon (?:already owns this store|is already running)/i.test(
      details,
    )
  )
    return {
      summary:
        "The project’s code index is in use by another process. Try again when it is available.",
      details,
    };
  if (/memcore-server did not become ready/i.test(details))
    return {
      summary:
        "MemCode timed out waiting for the code index to start. Try again in a moment.",
      details,
    };
  if (
    !details ||
    details.length > 180 ||
    /[\r\n]|\bstderr\b|\bMcpError\b|\bcommand failed\b/i.test(details)
  )
    return {
      summary: "MemCode couldn’t read the latest code analysis.",
      details,
    };
  return { summary: details };
}
