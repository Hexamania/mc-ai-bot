# Rust Targeted Block Mining

This document records the Rust implementation of targeted block mining on the
`rust-rewrite` branch. It describes the Rust command path; it does not mean the
overall Rust migration or desktop application is complete.

## Using the command

After authenticating as an admin, run:

```text
!mine <block-name>
```

Examples:

```text
!mine stone
!mine minecraft:diamond_ore
```

Block names are case-insensitive. The `minecraft:` namespace is optional, and
spaces in a name are normalized to underscores. Air blocks and invalid block
names are rejected. The command accepts exactly one block-name argument and is
restricted to admins.

The bot searches loaded world data for the nearest matching, breakable block
within 32 blocks. If a target is found, it:

1. Stops any active following or roaming operation.
2. Pathfinds to a position from which the target is reachable, without mining
   blocks along the route.
3. Checks that the target is still loaded, still the requested block, and still
   breakable.
4. Selects the fastest suitable tool currently in the hotbar, looks at the
   target, and mines it.

The bot replies privately when mining starts and privately reports completion
or a failure reason. `!stop` stops active mining and movement. Mining is also
cancelled when the bot dies, disconnects, shuts down, or replaces the active
movement operation.

## Implementation notes

- The runtime registers `mine` as an admin-only command and validates the block
  name before sending a mining action to the Minecraft connection.
- Mining runs asynchronously. It has a 30-second approach deadline and a
  30-second mining timeout; the target is revalidated after pathfinding.
- Reach is checked with Azalea's public `ReachBlockPosGoal` API. The spawned
  task scopes the world read lock to target validation and tool selection so
  that the async future remains `Send`.
- Mining uses Azalea's `BotClientExt` methods for tick synchronization, looking,
  and mining.

## Verification and change history

Focused tests cover block-name parsing, namespaced and case-insensitive block
IDs, rejection of invalid names and air, and admin permission/argument
validation.

The Windows `Rust core` workflow passed formatting, all-target checking, and
tests for this change:
[CI run 43550449967](https://github.com/Hexamania/mc-ai-bot/actions/runs/43550449967).
The implementation and follow-up compile fixes were pushed only to
`rust-rewrite`:

- `fc111b6` — add targeted block mining.
- `cdc86da` — use the exported Azalea APIs.
- `e057f4e` — release the world read lock before awaiting.
