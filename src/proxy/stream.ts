/**
 * Axion Lens - SSE stream utilities.
 *
 * Helpers for parsing Server-Sent Events out of a ReadableStream and for tee'ing
 * a response body so one branch flows straight to the caller (zero added latency)
 * while the other accumulates text for background belief extraction.
 *
 * We do NOT buffer the whole response before forwarding. The caller's branch is
 * piped through untouched; only the extraction branch buffers.
 */

import type { StreamChunk } from "./types";

/**
 * Parse a single SSE `data:` payload (without the `data: ` prefix) into text + done.
 * Handles OpenAI-style chat completion deltas.
 */
export function parseSseData(payload: string): StreamChunk {
  const trimmed = payload.trim();

  // Terminal sentinel - OpenAI streams end with `data: [DONE]`.
  if (trimmed === "[DONE]") {
    return { raw: payload, text: "", done: true };
  }

  let text = "";
  try {
    const json = JSON.parse(trimmed);
    // chat.completions.chunk - concatenate any delta.content fragments.
    const deltas = json?.choices?.[0]?.delta?.content;
    if (typeof deltas === "string" && deltas.length > 0) {
      text = deltas;
    } else if (Array.isArray(deltas)) {
      // Some providers send content as an array of parts.
      for (const part of deltas) {
        if (typeof part === "string") text += part;
        else if (part && typeof part.text === "string") text += part.text;
      }
    }
  } catch {
    // Not JSON or not the shape we expect - pass through untouched.
  }

  return { raw: payload, text, done: false };
}

/**
 * A tiny stateful SSE line parser. Feed it decoded chunks of text; it yields
 * complete `data:` payloads as they arrive (handling the `\n\n` SSE record
 * delimiter). This is necessary because a single ReadableStream read() may
 * return a partial SSE record or multiple records at once.
 */
export class SseLineParser {
  private buffer = "";

  /** Feed a chunk of text. Returns complete SSE data payloads found in it. */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    // SSE records are delimited by a blank line. Tolerate \n\n and \r\n\r\n.
    let idx: number;
    while ((idx = this.searchRecordDelimiter()) !== -1) {
      const record = this.buffer.slice(0, idx);
      const skip = this.delimLenAt(idx);
      this.buffer = this.buffer.slice(idx + skip);

      // A record may contain comment lines (`:`), event/id/retry fields, and
      // one or more `data:` lines. We join all data: lines with `\n` per spec.
      const dataLines: string[] = [];
      for (const line of record.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length > 0) {
        out.push(dataLines.join("\n"));
      }
    }
    return out;
  }

  /** Flush any trailing buffered content as a final record (if non-empty). */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest.trim()) return [];
    const dataLines: string[] = [];
    for (const line of rest.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    return dataLines.length > 0 ? [dataLines.join("\n")] : [];
  }

  private searchRecordDelimiter(): number {
    const i = this.buffer.indexOf("\n\n");
    const j = this.buffer.indexOf("\r\n\r\n");
    if (i === -1) return j;
    if (j === -1) return i;
    return Math.min(i, j);
  }

  private delimLenAt(idx: number): number {
    if (this.buffer.startsWith("\r\n\r\n", idx)) return 4;
    return 2;
  }
}

/**
 * Tee a Response body so one branch streams to the caller untouched while the
 * other accumulates the full decoded text for belief extraction.
 *
 * Returns the new Response to send to the caller (body = stream branch) and a
 * Promise<string> that resolves with the full accumulated text once the body
 * has been fully consumed.
 *
 * For SSE responses we parse `data:` lines to extract just the delta text.
 * For non-SSE responses we accumulate raw text.
 */
export function teeResponseForExtraction(
  response: Response,
  isSse: boolean
): { response: Response; accumulatedText: Promise<string> } {
  const body = response.body;
  if (!body) {
    return { response, accumulatedText: Promise.resolve("") };
  }

  const [callerStream, extractionStream] = body.tee();

  const accumulatedText = (async () => {
    let text = "";
    const reader = extractionStream.getReader();
    const decoder = new TextDecoder();
    const parser = new SseLineParser();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const decoded = decoder.decode(value, { stream: true });
        if (isSse) {
          for (const payload of parser.feed(decoded)) {
            text += parseSseData(payload).text;
          }
        } else {
          text += decoded;
        }
      }
      // Flush any trailing SSE data the parser still has buffered.
      if (isSse) {
        for (const payload of parser.flush()) {
          text += parseSseData(payload).text;
        }
      }
    } catch {
      // Best-effort accumulation - never fail the proxy over extraction.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }
    return text;
  })();

  const newResponse = new Response(callerStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  return { response: newResponse, accumulatedText };
}
