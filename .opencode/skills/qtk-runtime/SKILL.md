---
name: qtk-runtime
description: Use when QTK may have compressed or quieted tool output and exact raw command/tool output is needed for debugging, verification, or investigation.
---

# QTK Runtime Awareness

This project uses QTK, which may reduce tool-output noise before it reaches the
model.

QTK can:

- compress tool results after execution;
- save raw compressed output to `.opencode/qtk-tee/*.log`;
- apply safe Bash pre-call quiet rewrites such as `pytest -q`, `cargo --quiet`,
  `npm install --silent`, `pnpm install --silent`, and Gradle
  `--quiet --console=plain`;
- mark lossy generic output with `lossy=true` and a `tee=...` path.

If exact output matters:

1. Prefer reading the tee file referenced in the `<qtk-compressed ... tee=...>`
   envelope.
2. If rerunning a Bash command, use an explicit verbose/exact form such as:
   - `QTK_REWRITE_DISABLED=1 <command>` to disable only pre-call rewrites;
   - `QTK_DISABLED=1 <command>` to disable QTK for that command's environment;
   - command-native flags such as `--info`, `--debug`, `--stacktrace`,
     `--scan`, `--verbose`, `-v`, `-s`, or `--nocapture` when appropriate.
3. Do not assume compacted output contains every raw line. For `lossy=true`,
   exact details are in the tee file.

When reporting failures, mention whether evidence came from compacted output,
tee output, or an exact rerun.
