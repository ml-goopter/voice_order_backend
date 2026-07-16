# CLAUDE.md

## Requirements
- cart
- events
- menu
- ordering
- realtime

## Simplicity preferred over complexity

## Don't Repeat Yourself
- Prefer re-using existing functionality instead of inventing new ones.

## Workflow
### Plan before coding.
- Create a comprehensive plan about expected code structure, functionality, expected tests, and what lines to change before coding.
### Write the changes
### Antagonistic review
- Spawn a subagent with a fresh context window and this prompot to let it review the changes `Assume something is wrong with the changes, and find out what is wrong then report back`.
### Repeat until review comes back clean

## Be concise
- keep replies informational and concise. Never talk fillers.

## Knowledge base
- .claude/.knowledge contains an overview and change logs of each module, it may help you find the what and where in the code base.

## Skills
### Knowledge-base-maintance
- use this skill whenever you make changes to the code base