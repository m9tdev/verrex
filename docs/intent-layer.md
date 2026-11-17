# The Intent Layer

A hierarchical context system that embeds institutional knowledge directly
into a codebase, enabling AI agents to operate with the understanding of
senior engineers.

## The Problem: Dark Room Navigation

AI agents exploring large codebases face a fundamental constraint: **context
windows are finite, but codebases are not**.

Token scale:

- Single file: ~8k tokens
- Directory: ~120k tokens
- Service repo: ~2.5M tokens
- Multi-repo product: 20-100M tokens

Agents discover structure through exploration (grep, file reads, directory
listing). Every step costs tokens. Most of those tokens go to dead ends—
tests using mocks, high-level docs, files that seemed related but weren't.

Worse: irrelevant context actively degrades quality. Transformers weigh
every token against every other. Noise competes for attention, drowning
signal.

Even when agents find the right files, **code alone doesn't tell the whole
story**. Why does this abstraction exist? What must never happen here?
Where are the real boundaries? That knowledge lives in heads and scattered
docs—not in source files.

## The Solution: Intent Layer

The Intent Layer is a sparse tree of **Intent Nodes** (AGENTS.md, CLAUDE.md,
or similar files) placed at semantic boundaries throughout the codebase.

### Core Behavior

If an Intent Node exists in a directory:

1. It covers that directory and all subdirectories
2. It auto-loads into context whenever an agent works there
3. All ancestor nodes load automatically too (hierarchical context)

This gives agents a **T-shaped view**: broad context at the top, specific
detail where they're working.

### What Intent Nodes Contain

Each node is a dense, token-efficient briefing—the minimum high-signal
context an agent needs to operate safely in that area.

**Purpose & Scope**

- What this area is responsible for
- What it explicitly doesn't do

**Entry Points & Contracts**

- Main APIs, jobs, CLI commands
- Invariants: "All outbound calls go through this client"

**Usage Patterns**

- Canonical examples: "To add a new rule, follow this pattern..."

**Anti-patterns**

- Negative examples: "Never call this directly from controllers"

**Dependencies & Edges**

- Which other directories or services it depends on
- Downlinks to child Intent Nodes

**Patterns & Pitfalls**

- Things that repeatedly confused agents or humans
- Hidden state, deploy-time overrides, non-obvious behavior

### Downlinks

Related context outside the ancestor chain uses explicit pointers:

```markdown
## Related Context

- Payment validation rules: `./validators/AGENTS.md`
- Settlement engine: `./settlement/AGENTS.md`

## Architecture Decisions

- Why we use eventual consistency: `/docs/adrs/004-eventual-consistency.md`
```

Downlinks enable **progressive disclosure**—agents follow them when needed
rather than loading everything upfront.

## Building an Intent Layer

### The Capture Workflow

1. **Chunk the codebase** at semantic boundaries
2. **Leaf-first capture** with SME interviews
3. **Hierarchical summarization** up the tree

### Chunking Strategy

Chunk size affects compression ratio:

- 2k token file → 1k summary = poor ratio, high overhead
- 64k token chunk → 2-3k summary = excellent ratio

**Sweet spot: 20k-64k tokens per chunk**

Similar code compresses better together—this is why semantic boundaries
matter. Code sharing responsibility, patterns, and vocabulary summarizes
more efficiently than disparate code forced into one chunk.

### Hierarchical Summarization

The key compression mechanic:

> When capturing a parent, summarize child Intent Nodes—not the raw code
> they cover.

This creates **fractal compression**:

- Leaf nodes compress raw code into dense context
- Parent nodes compress their children's Intent Nodes
- A 2k token parent might cover 200k tokens of underlying code

### Capture Order: Squeeze Ambiguity

Capture in order of clarity: **children before parents, well-understood
areas before tangled ones**.

For each chunk:

1. Agent analyzes code + accumulated global state
2. Agent describes what it sees, asks clarifying questions
3. Human responds—corrects, explains history and landmines
4. Iterate until aligned on Intent Node content

Track what can't be resolved yet:

- **Open questions**: parked until a neighboring chunk answers them
- **Cross-references**: tracked until you find the right LCA
- **Tasks**: dead code candidates, refactors that emerge

### Least Common Ancestor (LCA) Placement

When a fact applies to multiple areas, place it in the **shallowest Intent
Node that covers all relevant paths**.

- Not in both leaf nodes (wasteful, will drift)
- Not in root (loads it in unrelated areas)
- LCA loads it exactly when needed: everywhere relevant, nowhere else

## Maintenance

### Sync Process

On every merge:

1. Detect which files changed
2. Identify which Intent Nodes cover those changes
3. For each affected node (leaf-first, working up):
   - Read the diff and existing node
   - Re-summarize if behavior changed
   - Propose updates
4. Human reviews and merges

This can be automated—an agent handles it on every commit/merge.

### Reinforcement Learning

When agents use the Intent Layer, they surface what's missing:

- Edge cases: contradictions, undocumented patterns
- Proposed updates: refined pitfalls, corrected invariants

Feed learnings back into the layer. Future agents start from a better
baseline. The codebase becomes a reinforcement learning environment—
agents get finetuned through better context, not expensive model training.

## File Naming

Different tools auto-load different files:

- Claude Code: `CLAUDE.md`, or `AGENTS.md` when a folder has no `CLAUDE.md`
- Codex: `AGENTS.md`
- Cursor: rules and skill files

Survey your team's tools and ensure nodes auto-load everywhere. Options:

- Symlinks (e.g., `AGENTS.md` → `CLAUDE.md`)
- Cursor rules/skills files
- Custom harness configurations

Avoid duplicating content across every filetype—this bloats the layer and
creates drift.

### What this repo does

`AGENTS.md` is the only node filename: no `CLAUDE.md`, not even as a
symlink, and no hooks. Claude Code loads `AGENTS.md` exactly where and how it
would load `CLAUDE.md` when a folder has none: the root node and its
ancestors at session start, nested nodes on demand when the agent reads
files in that folder. New nodes need no registration.

Do not use `.claude/rules/` with `@`-imports for nodes: imports expand
eagerly at session start regardless of `paths` scoping, loading the whole
node tree into every session.

## Naive vs. Effective Implementation

**Naive approach:**

- Single root file ballooning to 15k+ tokens
- Duplicates what's already in code
- Structures for human readers, not token-limited agents
- Drifts out of sync within weeks
- Misses hierarchical loading behavior

**Done right:**

- Compresses aggressively—minimum high-signal tokens per node
- Places nodes at semantic boundaries
- Uses downlinks for progressive disclosure
- Captures invariants not visible in code
- Structured capture protocol for tribal knowledge
- Maintenance automation to prevent rot

## Investment & Payoff

**Cost:**

- Experienced context engineer: 3-5 focused hours per 100k tokens
- New to it: budget 2-3x
- Maintenance: 5-10 minutes per PR (or automate entirely)

**Payoff:**

- Agents behave like senior engineers by default
- Longer tasks, parallel agents, higher-level operation
- Context compounds—explanations captured once, reused forever
- Single engineer + Intent Layer operates like a small team

The layer pays for itself on basically the next feature.
