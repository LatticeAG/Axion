/**
 * In-memory Server-Sent Event fan-out for one Session Durable Object.
 *
 * A Durable Object is the natural owner of its live subscribers: all writes
 * for a session and every connected stream are serialized through the same
 * instance. The timeline remains the durable source of truth; this helper is
 * deliberately ephemeral and only delivers beliefs written while a client is
 * connected.
 */

import type { ExtractedBelief } from "../lens/types.js";

/** Headers required for a browser EventSource response. */
export const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

const encoder = new TextEncoder();

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Render a single Axion belief as an SSE message.
 *
 * Keep this wire representation intentionally small and exact: dashboard
 * clients receive one `new-belief` event per extracted belief rather than a
 * batch wrapper, so they can append it directly to their live timeline.
 */
export function formatNewBeliefEvent(belief: ExtractedBelief): string {
  return `event: new-belief\ndata: ${JSON.stringify(belief)}\n\n`;
}

/**
 * Holds live SSE clients for one Session Durable Object instance.
 *
 * `ReadableStream.cancel()` and the request abort signal both detach a client.
 * Broadcasting is synchronous and never lets a broken client make a stored
 * batch fail; an enqueue error simply removes that stale client.
 */
export class SessionSseHub {
  private readonly subscribers = new Set<Subscriber>();

  /** Number of currently open live clients. Exposed for focused tests. */
  get size(): number {
    return this.subscribers.size;
  }

  /**
   * Open a streaming SSE response. An already-aborted request returns an
   * immediately closed stream and is never retained by the hub.
   */
  subscribe(signal?: AbortSignal): Response {
    let subscriber: Subscriber | undefined;
    const hub = this;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        subscriber = { controller, closed: false, signal };
        if (signal?.aborted) {
          hub.detach(subscriber, true);
          return;
        }

        if (signal) {
          const onAbort = () => {
            hub.detach(subscriber!, true);
          };
          subscriber.onAbort = onAbort;
          signal.addEventListener("abort", onAbort, { once: true });
        }
        hub.subscribers.add(subscriber);
      },
      cancel() {
        if (subscriber) hub.detach(subscriber, false);
      },
    });

    return new Response(stream, { headers: new Headers(SSE_RESPONSE_HEADERS) });
  }

  /**
   * Fan out each belief in a newly stored batch to every current subscriber.
   * Returns the number of successful event enqueues, which is useful for
   * diagnostics and tests but intentionally does not affect persistence.
   */
  publish(beliefs: readonly ExtractedBelief[]): number {
    let delivered = 0;
    for (const belief of beliefs) {
      const payload = encoder.encode(formatNewBeliefEvent(belief));
      // Copy before iteration because an enqueue can synchronously detach a
      // stream in some runtimes.
      for (const subscriber of [...this.subscribers]) {
        if (subscriber.closed) {
          this.detach(subscriber, false);
          continue;
        }
        try {
          subscriber.controller.enqueue(payload);
          delivered += 1;
        } catch {
          // A disconnected EventSource must not make a successful timeline
          // write fail, nor remain strongly referenced by the session DO.
          this.detach(subscriber, false);
        }
      }
    }
    return delivered;
  }

  /** Close and remove every subscriber (primarily useful during teardown). */
  closeAll(): void {
    for (const subscriber of [...this.subscribers]) {
      this.detach(subscriber, true);
    }
  }

  private detach(subscriber: Subscriber, closeStream: boolean): void {
    if (subscriber.closed) return;

    subscriber.closed = true;
    this.subscribers.delete(subscriber);
    if (subscriber.signal && subscriber.onAbort) {
      subscriber.signal.removeEventListener("abort", subscriber.onAbort);
    }
    if (closeStream) {
      try {
        subscriber.controller.close();
      } catch {
        // A reader may have cancelled between the abort and close call.
      }
    }
  }
}
