/**
 * Shared structural guards for untrusted single-record JSON input.
 *
 * `JSON.parse` keeps the last occurrence of a duplicate object key, so a
 * hostile record can show one value to a human reader and hand a different
 * one to every later consumer. This scanner rejects a duplicate object key
 * (and malformed structure) before parsing, without building a second object
 * graph. It is the single implementation used by the campaign ctl-envelope
 * validator and the debug-protocol response decoder.
 *
 * Callers pass a single JSONL line; embedded newlines are rejected by the
 * callers before this runs.
 */

export class DuplicateJsonKeyError extends SyntaxError {
  constructor(public readonly key: string) {
    super("JSON contains a duplicate object key");
    this.name = "DuplicateJsonKeyError";
  }
}

export function assertUniqueJsonObjectKeys(raw: string): void {
  const stack: Array<
    { kind: "object"; keys: Set<string> } | { kind: "array" }
  > = [];
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "{") {
      stack.push({ kind: "object", keys: new Set<string>() });
      continue;
    }
    if (character === "[") {
      stack.push({ kind: "array" });
      continue;
    }
    if (character === "}" || character === "]") {
      const expected = character === "}" ? "object" : "array";
      const current = stack.pop();
      if (current?.kind !== expected) {
        throw new SyntaxError("JSON contains mismatched structure");
      }
      continue;
    }
    if (character !== '"') continue;
    let end = index + 1;
    let escaped = false;
    for (; end < raw.length; end += 1) {
      const code = raw.charCodeAt(end);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (raw[end] === "\\") {
        escaped = true;
        continue;
      }
      if (raw[end] === '"') break;
      if (code < 0x20) {
        throw new SyntaxError("JSON string contains a control character");
      }
    }
    if (end >= raw.length) {
      throw new SyntaxError("JSON contains an unterminated string");
    }
    const current = stack.at(-1);
    if (current?.kind === "object") {
      let next = end + 1;
      while (next < raw.length && /\s/u.test(raw[next] ?? "")) next += 1;
      if (raw[next] === ":") {
        const parsedKey: unknown = JSON.parse(raw.slice(index, end + 1));
        if (typeof parsedKey !== "string") {
          throw new SyntaxError("JSON object key is not a string");
        }
        if (current.keys.has(parsedKey)) {
          throw new DuplicateJsonKeyError(parsedKey);
        }
        current.keys.add(parsedKey);
      }
    }
    index = end;
  }
  if (stack.length > 0) {
    throw new SyntaxError("JSON contains unclosed structure");
  }
}
