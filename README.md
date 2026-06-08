# pi-memory-dreaming

`pi-memory-dreaming` gives pi an automatic memory system. Once installed, it
learns durable preferences, facts, corrections, workflows, and project context
from your conversations, then reuses approved memories as background context in
future turns.

You do **not** need to run `/dreaming` during normal use. The slash command is
only for checking status, manually forcing a run, and managing saved/candidate
memories.

## Install

From npm:

```bash
pi install pi-memory-dreaming
```

Or try it for one pi run without installing:

```bash
pi -e pi-memory-dreaming
```

For local development from this repository:

```bash
pi install /absolute/path/to/pi-memory-dreaming
```

Or run the local checkout once without installing:

```bash
pi -e /absolute/path/to/pi-memory-dreaming
```

## Automatic behavior

`pi-dreaming` is enabled by default. It automatically:

- recalls active memories before each agent turn and appends them to the system
  prompt as background context;
- attempts memory synthesis after each agent turn;
- also checks on a timer, every 5 minutes by default, and skips work when the
  conversation has not changed or is still below the minimum digest size.

New high-confidence, non-sensitive memories can be saved automatically. Lower
confidence or sensitive memories remain as candidates until you approve or
reject them.

Memories are stored per project at `.pi/dreaming/memories.json` with file mode
`0600` when supported by the filesystem.

## Management commands

Use `/dreaming` when you want to inspect or manage the automatic memory system:

```text
/dreaming status
/dreaming list [active|candidates|all]
/dreaming show <id>
/dreaming run [--dry-run] [--force]
/dreaming approve <candidate-id>
/dreaming reject <candidate-id>
/dreaming forget <memory-id>
/dreaming enable
/dreaming disable
```

## Development

```bash
bun install
bun run check
bun run pack:dry-run
```
