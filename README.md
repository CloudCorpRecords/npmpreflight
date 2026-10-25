# npmpreflight

Audit a package directory before `npm publish`, while a bad publish is
still cheap to undo.

npmpreflight resolves the file set your package would actually ship,
scans the shipped files for secret patterns, totals the size, and checks
`package.json` for the fields and entry points a publish depends on. It
answers the questions that are embarrassing to discover after a release:
is a credential sitting in a shipped file, does the `bin` target exist
in the tarball, is the license field set, and is a scoped package about
to publish as restricted.

## Install

Run it without installing:

```sh
npx @reneturcios/npmpreflight check .
```

Or install it globally:

```sh
npm install -g @reneturcios/npmpreflight
npmpreflight check .
```

Requires Node 20 or newer.

## CLI usage

```sh
npmpreflight check [path] [--json]
npmpreflight mcp
npmpreflight --version
```

- `check [path]` audits the package directory at `path` (default: the
  current directory) and prints a human readable report. Add `--json`
  for the machine readable report.
- `mcp` starts the MCP server over stdio (see below).
- `--version` prints the version.

Exit codes: `0` when the verdict is READY, `1` for any other verdict,
`2` for a usage error or an unreadable or invalid `package.json`, and
`141` when the reader closed the output pipe early.

Example output:

```text
npmpreflight check .: FIX-FIRST
  files: 4, bytes: 603, findings: 2 (high: 2, medium: 0, low: 0, info: 0)
  summary: 4 shipped file(s), 603 byte(s), 2 finding(s) (2 high, 0 medium, 0 low, 0 info). High-severity findings must be fixed before publishing.
  [HIGH] SECRET-LEAK src/index.js:2 Shipped file matches the secret pattern private-key-block. Remove the credential from the package and rotate it if it was ever real. (evidence: private-key-block)
  [HIGH] SECRET-LEAK src/index.js:3 Shipped file matches the secret pattern github-pat-classic. Remove the credential from the package and rotate it if it was ever real. (evidence: github-pat-classic)
FIX-FIRST: resolve the high-severity findings before publishing.
```

Findings never include the matched secret text. The evidence for a
secret finding is the pattern id only, plus the file and line, so a
report is safe to paste into an issue or a CI log.

## MCP

The same audit is available as an MCP tool over stdio:

- Tool: `preflight_package`
- Input: `path`, the package directory to check
- Output: the JSON report, identical to `check --json`

Start it with `npmpreflight mcp`, or configure an MCP client to run
`npx @reneturcios/npmpreflight mcp`. The server is also published as an
OCI image and listed in `server.json` under the name
`io.github.CloudCorpRecords/npmpreflight`.

## Checks

| Rule | Severity | What it flags |
| --- | --- | --- |
| MISSING-FIELD | high | `package.json` is missing one of `name`, `version`, `license`, or `description` (one finding per missing field). |
| BIN-MISSING | high | A `bin` path in `package.json` is not in the shipped file set. |
| MAIN-MISSING | high | The `main` entry point is not in the shipped file set. |
| SECRET-LEAK | high | A shipped text file matches a secret pattern: a private key block header, an AWS access key id shape (`AKIA` plus 16 characters), a classic GitHub token shape (`ghp_` plus 36 or more characters), a fine grained GitHub token shape (`github_pat_` prefix), an `sk-` API key shape, or a generic `api_key` style assignment with a long quoted value. Evidence is the pattern id only. |
| OVERSIZE | medium | Total shipped size over 10 MiB, or any single shipped file over 1 MiB (one finding per oversize file). |
| SCOPED-NO-PUBLISHCONFIG | medium | The package name is scoped (starts with `@`) and `publishConfig.access` is not `public`. |
| NO-README | low | No README file is in the shipped set. |
| NO-ENGINES | info | `package.json` declares no `engines` range. |

Every report counts the shipped files and their total bytes, plus the
finding totals by severity.

## Verdict

- `READY` when there are no high severity findings. Medium, low, and
  info findings are reported but do not block the verdict.
- `FIX-FIRST` when at least one high severity finding exists.

## How the shipped file set is resolved

- If `package.json` has a `files` array, those paths are included:
  files are added directly and directories are walked recursively.
  `package.json`, `README`, and `LICENSE` are always included when
  present, whether or not they are listed, matching npm.
- If there is no `files` array, everything in the directory is included
  except `node_modules`, `.git`, and paths matched by `.npmignore`
  when one is present. The always included files above are still
  included even if an ignore rule would match them.
- The walk is capped at 5000 shipped files. When the cap is reached
  the report records it in its counts (`truncated: 1`, with
  `filesSeen` and `maxFiles`) and the render notes that the remaining
  files were not scanned.

## Limits

Read these before trusting a clean verdict:

- The file set is a static resolution, not a byte-exact `npm pack`.
  npm applies more rules (its own always excluded files, lifecycle
  generated files, and publish time behaviour) that a static pass does
  not reproduce. Treat npmpreflight as a preflight check, then confirm
  a release with `npm pack --dry-run`.
- `.npmignore` support is a simple subset: blank lines, `#` comments,
  plain lines (a file name at any depth, or an exact relative path),
  and directory patterns ending in `/`. Globs, negations, and
  character classes in `.npmignore` are not supported and such lines
  will not match the way npm would match them.
- `files` entries support literal files, literal directories, simple
  `*` and `**` globs, and `!` negations of those. Anything more exotic
  is resolved literally and may differ from npm.
- Secret scanning reads text files only. A file whose scanned head
  contains a NUL byte is treated as binary and skipped. Only the first
  512 KiB of each file is scanned, so a secret past that offset in a
  large file will not be found. Patterns are shapes, not proof: a
  match can be a test fixture or an example, and a real credential in
  an unrecognized shape will not match.
- Symlinks are not followed and are not shipped.
- Output is deterministic: findings are sorted, counts are stable,
  and no timestamps are emitted.

## Development

```sh
npm install
npm run build
npm test
```

## License

MIT
