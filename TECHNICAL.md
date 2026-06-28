# Axion — Technical Specification

> Deep-dive into the architecture, data flow, and implementation details.
> For a high-level overview, see [README.md](./README.md). For the full build plan, see [SPEC.md](./SPEC.md).

---

## System Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │                  Axion Worker                │
                    │              (Cloudflare Workers)             │
                    │                                             │
     Agent  ──HTTP──→  fetch()  →  route handler                   │
                    │                  │                            │
                    │     ┌───────────┼───────────┐                │
                    │     │           │           │                │
                    │     ▼           │           ▼                │
                    │  stream.ts     │      routes.ts              │
                    │  (SSE proxy)   │      /dashboard             │
                    │     │           │      /api/beliefs/:id     │
                    │     │           │      /api/sessions        │
                    │     ▼           │                            │
                    │  extraction.ts  │     SessionDurableObject   │
                    │  (waitUntil)    │      .fetch() → belief DAG │
                    │     │           │                            │
     Model API ←────┘     ▼           │                            │
                    │  lens/extract  │                            │
                    │  (regex+NLP)   │                            │
                    │     │           │                            │
                    │     ▼           │                            │
                    │  SessionDurableObject.addBelief()             │
                    │  (persisted in DO memory)                     │
                    └─────────────────────────────────────────────┘
```

### Request Flow (Phase 1 — Axion Lens)

```
1. Agent sends POST /v1/chat/completions with messages[]
2. Worker receives request, extracts session ID from x-axion-session header
3. Worker forwards request to upstream Model API (UPSTREAM_API_URL)
4. Response streams back through two paths via TransformStream tee:
   ├── Path A: streamed to agent immediately (zero added latency)
   └── Path B: accumulated in buffer for belief extraction
5. When stream completes:
   ├── waitUntil() triggers extractBeliefs(fullResponseText, sessionId)
   ├── Beliefs extracted via regex patterns (sub-millisecond)
   └── Beliefs stored in Durable Object via addBelief()
6. Dashboard fetches /api/beliefs/:sessionId → DO returns belief graph JSON
```

### Latency Budget

| Stage | Time | Blocking? |
|---|---|---|
| Request forwarding | <1ms | Yes (unavoidable) |
| SSE streaming | Passthrough | No (streamed to caller) |
| Full response accumulation | Stream duration | No (parallel with streaming) |
| Belief extraction | <1ms | No (waitUntil) |
| Belief storage in DO | <5ms | No (waitUntil) |
| **Added latency to agent** | **<1ms** | — |

---

## Module Deep-Dive

### src/proxy/stream.ts — SSE Streaming Proxy

The core of Axion Lens. Handles both streaming (`stream: true`) and non-streaming responses.

**Streaming flow:**
1. Forward the request to the upstream API
2. Create a `TransformStream` that tees the response body
3. One readable stream goes to the caller (the agent) — immediate, zero buffering
4. The other stream accumulates chunks into a buffer string
5. When the readable stream to the caller ends, `waitUntil()` fires
6. The accumulated buffer is passed to `extractBeliefs()`

**Non-streaming flow:**
1. Forward the request to the upstream API
2. Clone the response (response can only be read once)
3. One clone goes to the caller immediately
4. The other clone is read as text and passed to `extractBeliefs()` via `waitUntil()`

**Key invariant:** The agent never waits for belief extraction. The response is forwarded immediately regardless of streaming mode.

### src/lens/patterns.ts — Belief Extraction Patterns

Patterns are defined as an extensible array:

```typescript
interface BeliefPattern {
  regex: RegExp;
  type: 'causal' | 'assumption' | 'intention' | 'evidence';
  confidence: number;  // base confidence
  groupIndex: number;  // which regex group contains the belief text
}
```

Each pattern matches a linguistic construct and extracts the relevant text. The extracted text becomes the `belief` field of an `ExtractedBelief`.

**Confidence modifiers** are applied after pattern matching:
- "definitely", "certainly" → +0.2
- "probably", "likely" → +0.1
- "might", "could be" → -0.1
- "not sure", "uncertain" → -0.3

Final confidence is clamped to [0.1, 1.0].

### src/lens/extract.ts — Extraction Pipeline

```
Input: responseText (string), sessionId (string)

1. Split response into sentences (split on . ! ? \n)
2. For each sentence, test against all patterns in patterns.ts
3. For each match:
   a. Extract belief text from regex group
   b. Look for confidence modifiers in surrounding context
   c. Apply modifiers to base confidence
   d. Create ExtractedBelief object with UUID + timestamp
4. Link beliefs to parent (previous belief in session) for DAG
5. Return ExtractedBelief[]

Output: ExtractedBelief[]
```

### src/state/SessionDurableObject.ts — Belief DAG

Each agent session gets one Durable Object instance. The DO holds beliefs in memory as a `Map<string, BeliefNode>`.

```typescript
interface BeliefNode {
  id: string;
  type: 'causal' | 'assumption' | 'intention' | 'evidence';
  belief: string;
  evidence?: string;
  confidence: number;
  actionTaken?: string;
  timestamp: number;
  parentId: string | null;
  childrenIds: string[];
}
```

**DAG construction:** When `addBelief(belief)` is called, if `parentId` is provided, the new node is linked as a child of the parent. This creates a tree structure within the session — each belief is connected to the one that preceded it, enabling root-cause backtracking.

**DO fetch handler:**
- `GET /` → returns full belief graph as `{ nodes: BeliefNode[], edges: [{parent, child}] }`
- `POST /` → adds a belief to the graph, body is `ExtractedBelief`
- `GET /type/:type` → filter by belief type
- `GET /root-cause/:failedActionId` → backtrack from a failed action to root-cause belief

---

## TypeScript Types

### Core Types (src/lens/types.ts)

```typescript
type BeliefType = 'causal' | 'assumption' | 'intention' | 'evidence';

interface ExtractedBelief {
  id: string;
  sessionId: string;
  type: BeliefType;
  belief: string;
  evidence?: string;
  confidence: number;       // 0.0–1.0
  actionTaken?: string;
  timestamp: number;         // Unix ms
  rawText: string;
}

interface BeliefNode extends ExtractedBelief {
  parentId: string | null;
  childrenIds: string[];
}

interface BeliefDAG {
  sessionId: string;
  nodes: Map<string, BeliefNode>;
  rootIds: string[];
}

interface BeliefPattern {
  regex: RegExp;
  type: BeliefType;
  confidence: number;
  groupIndex: number;
}
```

---

## Durable Object: Design Decisions

### Why Durable Objects (not KV, not D1)?

| Option | Chosen? | Why |
|---|---|---|
| Durable Objects | Yes | In-memory belief graph, single-writer consistency, per-session isolation, sub-ms reads |
| KV | No | Eventually consistent, no complex queries, no in-memory graph |
| D1 | No | SQL is overkill for a graph, adds cold starts, not per-session isolated |
| Workers Cache | No | Not durable across requests, no transactional guarantees |

### Memory Limits

Durable Objects have a 128MB memory limit. A single belief node is ~500 bytes. That's ~256K beliefs per session — far beyond what any reasonable agent session produces (typical: 50–500 beliefs).

If sessions grow beyond this, the DO can flush old beliefs to Durable Storage (persistent disk) and lazy-load on access. Not needed for Phase 1.

---

## Dashboard Architecture

The dashboard is a single-page React app served as static assets from the Worker.

### Design Constraints

- **No build step** — React is loaded from CDN via `<script>` tags. This means no JSX. All components use `React.createElement()`.
- **No bundler** — `app.js` is plain JavaScript, served directly.
- **No CSS framework** — hand-written CSS in `styles.css`.

### Component Tree

```
App
├── SessionSelector (dropdown of available sessions)
├── StatsBar (total beliefs, avg confidence, type breakdown)
├── FilterBar (type filter, min confidence, wrong-only toggle)
├── Timeline
│   └── BeliefCard[] (one per belief)
│       ├── TypeBadge (colored by type)
│       ├── BeliefText
│       ├── MetaRow (evidence, action, confidence bar)
│       └── Timestamp
└── Footer (LatticeAG wordmark)
```

### API Endpoints (consumed by dashboard)

| Endpoint | Method | Returns |
|---|---|---|
| `/api/sessions` | GET | `{ sessions: string[] }` |
| `/api/beliefs/:sessionId` | GET | `{ beliefs: ExtractedBelief[] }` |
| `/dashboard` | GET | HTML (dashboard page) |
| `/styles.css` | GET | CSS (static asset) |
| `/app.js` | GET | JS (static asset) |
| `/v1/chat/completions` | POST | Streaming/non-streaming model response (proxy passthrough) |

---

## Configuration

### wrangler.toml

```toml
name = "axion"
main = "src/proxy/index.ts"
compatibility_date = "2024-09-23"

[vars]
UPSTREAM_API_URL = "https://api.openai.com"

[[durable_objects.bindings]]
name = "SESSION"
class_name = "SessionDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["SessionDurableObject"]

[assets]
directory = "./src/dashboard"
binding = "ASSETS"
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `UPSTREAM_API_URL` | Yes | — | Base URL of the upstream model API |
| `UPSTREAM_API_KEY` | No | — | API key forwarded to upstream (if not set, agent's own key is passed through) |

---

## Extending the Pattern Engine

The belief extraction patterns are designed to be extensible. To add a new pattern:

1. Open `src/lens/patterns.ts`
2. Add a new entry to the `PATTERNS` array:

```typescript
{
  regex: /I believe that (.+?)(?:\.|$)/i,
  type: 'assumption',
  confidence: 0.6,
  groupIndex: 1,
}
```

3. If adding a new belief type, update `BeliefType` in `types.ts` and add the color mapping in `styles.css`.

The extraction engine automatically picks up new patterns — no changes to `extract.ts` needed.

---

## Phase 2: Axion Loop (Planned)

**Goal:** Detect when an agent is stuck in a revision loop and intervene with targeted feedback.

### Architecture Extension

```
Axion Lens (Phase 1)
  └── belief graph
        ↑
Axion Loop (Phase 2)
  ├── embedding engine (cheap embedding model via API)
  ├── sliding window (last 10-20 outputs)
  ├── cosine similarity detector (threshold: 0.85)
  ├── loop classifier (productive vs stuck vs thrashing)
  └── intervention injector (system message injection)
```

### Intervention Ladder

1. **Soft nudge** (first detection): Inject "You've tried [X] 3 times. Consider: [alternatives]."
2. **Hard nudge** (second detection): Force re-read of original task + constraints
3. **Escalate** (third detection): Stop agent, alert human with summary

### Dependencies

- Embedding model API (can use OpenCode Zen cost-optimised routing)
- Belief graph from Phase 1 (for loop classification)

---

## Phase 3: Axion Gate (Planned)

**Goal:** Intercept tool calls before execution and verify them against the agent's stated plan.

### Architecture Extension

```
Axion Lens (Phase 1)
  └── belief graph + stated plan
        ↑
Axion Gate (Phase 3)
  ├── tool call interceptor (file, shell, API)
  ├── plan alignment checker
  ├── contradiction detector
  ├── anti-pattern matcher (rules engine)
  └── correction injector
```

### Verification Checks

1. **Plan alignment:** Does this action match the agent's stated plan from the belief graph?
2. **Contradiction:** Does this action contradict a prior decision?
3. **Pattern matching:** Does this match a known failure anti-pattern?

If any check fails, the action is blocked and a correction is injected into the agent's context.

---

## Open-Source vs SaaS

| Feature | Open-Source (self-hosted) | SaaS (hosted) |
|---|---|---|
| Proxy + belief extraction | Yes | — |
| Local dashboard (single session) | Yes | — |
| Hosted multi-session dashboard | — | Yes |
| Cross-session belief analysis | — | Yes |
| Team sharing + alerting | — | Yes |
| Community belief pattern library | — | Yes |

The open-source core is fully functional standalone. The SaaS layer adds convenience, collaboration, and community features.

---

## Provenance

- **Author:** Moses / LatticeAG
- **GitHub:** [mosesman831](https://github.com/mosesman831)
- **License:** MIT
- **Brand:** LatticeAG — *"Agents, together."*
