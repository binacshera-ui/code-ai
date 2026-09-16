# Flow Creation Mode — architecture and delivery plan

## Product outcome

Flow Creation Mode turns a session into a living library of editable system maps. The agent explains the real code and runtime in plain Hebrew, CODE-AI renders the active map as a calm pastel graph, and every user edit becomes part of the next agent turn.

The complete loop is:

1. The user enables Flow Creation Mode for a draft or an existing session.
2. The user creates, names, duplicates, deletes, or switches maps inside the same session.
3. CODE-AI adds the active canonical flow, a lightweight map index, and the `bina-flow` contract to every turn.
4. The agent investigates the real system and ends its answer with one complete `bina-flow` JSON document for that active map only.
5. The server validates and versions the document before persisting it into the targeted map.
6. A “צפה בזרימה” action opens the React Flow canvas and map shelf.
7. The user can move, connect, add, edit, or remove modules and save a new map revision.
8. “שאל או בקש שינוי” sends the selected module, active map identity, and instruction back to the same session. The server supplies the latest full active map, so the agent always works from the current visual state.

## Foundation decision

Use `@xyflow/react` 12.11.6 as the interaction engine, pin `@dagrejs/dagre` 3.1.1 (MIT) as the directed layered-layout engine, and keep all business semantics inside CODE-AI.

Why:

- The same engine is already proven in Bina Cshera 3.0's workflow builder.
- It supplies the hard canvas primitives: pan, zoom, fit view, selection, connection handles, keyboard deletion, controls, and MiniMap.
- It is MIT licensed and actively maintained.
- It does not dictate our domain model, persistence, validation, prompts, or visual language.
- Dagre replaces the original hand-written topological layout. It handles cycles, rank assignment, branch ordering, crossing reduction, and disconnected components while React Flow remains the renderer/editor.
- Multiple maps do not require a second canvas engine or a client-side global graph store. CODE-AI owns a server-side map library and renders one controlled React Flow instance for the active map. This keeps large sessions bounded and preserves the established editor behavior.

Rejected alternatives:

- A custom SVG/canvas engine would duplicate mature interaction and accessibility work.
- ELK Layered is stronger for deeply nested compound graphs and advanced port routing, but `elkjs` 0.12.0 adds a substantially larger runtime and its EPL-2.0/GPL licensing is less convenient for this client bundle. The current product does not need those missing capabilities.
- A Mermaid-only view would be readable but would not support direct manipulation and module-level continuation.
- Reusing Bina 3.0's workflow document one-to-one would leak execution semantics into an explanatory architecture map.

Known Dagre boundary and integration plan:

- Dagre owns only deterministic rank assignment and initial coordinates. React Flow owns rendering, interaction, handles, zoom, selection, and manual edits.
- Groups remain semantic badges rather than compound layout containers. Typed smooth-step edges provide the visual routing layer that Dagre itself does not render.
- Tarjan strongly connected components are collapsed before stage numbering, so cycles stay readable and do not corrupt start/end semantics.
- `dependency` and `deploy` edges are secondary context and do not move a module to a later primary-flow stage.
- Saved documents carry `layoutVersion`. Missing, zero, or older versions are migrated once through the current layout; current manual positions remain stable until the user chooses “reset layout”.

## Canonical contract

The server owns schema version 1 for each map document. A session flow record contains a lightweight ordered map library, an `activeMapId`, and the full documents on the server. The client receives summaries for every map and the full document for the active map only.

A map document contains:

- Human title, subtitle, and summary.
- Modules with kind, ownership, status, technology, runtime, repository path or external URL, detailed explanation, tags, evidence, and optional position.
- Typed connections with a short label and a human explanation.
- Optional visual groups for domains or layers.

The server enforces IDs, text limits, valid ownership/status values, unique modules, valid connection endpoints, and graph size limits. Unknown fields are discarded. Every accepted session operation increments a library revision; every map edit independently increments that map's optimistic revision. Version-1 single-map records are promoted automatically without losing their document.

## Trust and lifecycle boundaries

- Agent output is untrusted input until it passes canonical validation.
- The browser never writes storage files directly.
- Draft-session flow state is rebound atomically to the real session ID.
- Session deletion also deletes flow state.
- Existing documents are included in the next prompt as full compact JSON.
- Only the active map is included as full JSON. Other maps are represented by a small title/count index, preventing prompt growth from multiplying with the number of maps.
- A running agent turn is pinned to the active map ID and map revision captured at dispatch time. If the user switches maps meanwhile, valid output returns to the original map instead of overwriting the newly selected map. If that original map changed meanwhile, the stale output is rejected.
- The agent must distinguish repository-owned code, managed infrastructure, containers, and external services, and attach file/URL/note evidence when known.
- Invalid or partial `bina-flow` blocks do not replace the last valid document.

## UI architecture

- Mode card: enable/disable, explanation depth, optional brief, active-map revision and module count.
- Session chip: shows the map count and active map, and opens the canvas.
- Completion action: shows “צפה בזרימה” only when a validated document exists and the current turn is no longer running.
- Map shelf: horizontal, touch-friendly tabs for switching maps plus create, rename, duplicate, and guarded delete actions. Dirty edits are saved before switching or creating another map.
- Canvas: custom pastel module nodes, relationship labels, MiniMap, zoom/fit controls, search and filters.
- Inspector: fully editable agent-authored details and evidence.
- Reading: explicit start/end anchors, numbered stages, right-to-left direction, typed arrow styling, and click-to-focus ancestor/descendant paths.
- Editing: add module, connect modules, move, delete, edit, assign a flow role, reset the layered layout, save with conflict detection.
- Continuation: selected-module context plus the user's instruction is placed in the composer; the latest complete graph is injected server-side at send time.

## Verification and rollout

- Unit tests cover normalization, invalid edges, fenced-output extraction, persistence, legacy migration, library operations, per-map revision conflicts, asynchronous agent targeting, and draft rebinding.
- Production build verifies the React Flow integration and server bundle.
- Browser QA covers mode activation, canvas opening, edit/save/reload, and composer handoff at desktop and narrow panel widths.
- Deployment follows the existing CODE-AI multi-host release flow with health checks and rollback-safe releases.
