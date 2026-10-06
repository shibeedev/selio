/** An error caused by the caller's input or the current market state, returned to the agent as a tool error. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** First ToolError along an error's cause chain: viem keeps an error thrown by the transport as `cause`. */
export function findToolError(err: unknown): ToolError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 10 && typeof current === "object" && current !== null; depth++) {
    if (current instanceof ToolError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Message shown to the agent for any failure inside a tool. */
export function errorMessage(err: unknown): string {
  const toolError = findToolError(err);
  if (toolError) return toolError.message;
  if (err instanceof Error) {
    const short = (err as { shortMessage?: unknown }).shortMessage;
    return `Chain request failed: ${typeof short === "string" ? short : err.message}`;
  }
  return "Unknown error";
}
