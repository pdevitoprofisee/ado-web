# Local git inventory (T-041)

What `git` costs and what it answers on this machine, measured against the real repository root
before any of round 6 was written. Read-only throughout: **every command below is a read.** No
`fetch`, no `checkout`, no `stash`, nothing that writes a ref, and `--no-optional-locks` on the
invocations that would otherwise touch `.git/index`.

- **Machine:** Windows 11, `C:\Users\PaulDe\repos` as the root.
- **git:** `2.55.0.windows.3` (`git --version`).
- **Taken:** 2026-07-31.

## Provenance — read this before trusting a decimal point

The other files in this directory were produced by a script in `scripts/` and can be re-run.
**This one cannot.** Rounds 3, 4 and 5 each opened with a live probe against a credential nobody
had used yet; local git needs no credential, so these numbers were taken interactively during
the design session that produced [round 6](../tickets/round-6.md) and are **transcribed** here
rather than regenerated. Two consequences, stated rather than hidden:

- The **numbers** are what was observed. The **commands** beside them are the invocations that
  produce them, written out here in the form the server layer will use — they are not copied
  from a saved transcript, so treat an argv as a recipe and a figure as a measurement.
- Anything that says *not recorded* below is a gap in the transcription, not a zero.

Re-measuring is cheap — no credential, no rate limit, no colleague's build — so anything here
that a decision leans hard on should be re-run rather than argued with.

---

## 1 — The census

One level deep under the root, never recursive. A child is a repository if it answers
`rev-parse`:

```
git -C <root>/<child> --no-optional-locks rev-parse --show-toplevel
```

| fact | count |
|---|---|
| children that answer `rev-parse --show-toplevel` | **19** |
| on a feature branch | **7** |
| on their own default branch | **11** |
| sharing the branch `chore/support-aspire-and-containers` | **6** |
| with uncommitted changes | **6** |
| with a gitlink or a `.gitmodules` | **0** |
| with no remote at all | **2** (`ado-web`, `xshot`) |

**7 + 11 is 18, not 19.** The transcription does not say which repository the nineteenth is or
which bucket it fell into. Counted here as a hole in the record rather than rounded into the
larger number — the census is a measurement and "about nineteen" is not.

Two shape facts that matter more than the counts:

- **The root holds three orphaned `node_modules` directories.** That, plus `platform`'s 13,807
  tracked files, is why the scan is one level deep and never recursive. A recursive walk of this
  root reads tens of thousands of directories to find nineteen `.git`s.
- **A repository appeared under the root mid-session** (`dev-utilities`). Which is why the
  repository list is **never cached**: the scan is the answer, and a cached scan is a list that
  is wrong exactly when somebody has just cloned something.

Tracked file counts, for scale (`git -C <repo> ls-files | wc -l`): `platform` **13,807**,
`ado-web` **219**. Across all 19, **14,000+** tracked entries.

## 2 — What a spawn costs

```
git -C <repo> --no-optional-locks <trivial subcommand>
```

| spawns | wall clock | per spawn |
|---|---|---|
| 10 | 0.523 s | 52.3 ms |
| 20 | 1.085 s | 54.3 ms |

**~52 ms, and it is linear**, which means essentially all of it is process start and none of it
is the work. The exact subcommand is *not recorded*; the linearity is the finding, and it is the
finding because it makes the cost per invocation and not per byte.

What that implies for the diff: a file needs **two** blobs, so a spawn per side is **~105 ms per
file**. On the largest pull request this app has measured (294 files, T-016) that is **~31 s** of
process start to read a diff. See §3 for the number that replaces it.

## 3 — `cat-file --batch`

Shas on stdin, one process:

```
git -C <repo> --no-optional-locks cat-file --batch
```

**200 blobs through one process: 2.09 s — ~10 ms each.** Against ~52 ms for a spawn, so on a
294-file change (588 blobs) the comparison is **~6 s batched against ~31 s spawned**. This is why
the blob layer is one spawn per *file* and not per side, and why it is not one spawn per blob.

The framing, which is the part a parser has to get exactly right:

```
<sha> SP <type> SP <size> LF
<size bytes>
LF
```

and for a sha the object database does not hold:

```
<sha> SP missing LF
```

**The size is declared before the bytes arrive.** That is the fact that finally gives
`BlobSide`'s `too-large` arm a live domain: `diff-contract.ts` records that ADO declares a length
only below ~256 KiB and goes chunked above it, so the length check there refuses nothing that
ever happens. Here the number comes first, so an over-limit blob is refused **without being
buffered**.

**But its bytes must still be drained.** The stream is a single sequence of framed records with
no delimiter to resynchronise on; skipping *size* + 1 bytes' worth of reading does not skip them
on the pipe, and every file after the refused one then parses garbage. Refuse the content, read
the bytes.

## 4 — `status --porcelain=v2`

```
git -C <repo> --no-optional-locks status --porcelain=v2 --branch
```

| | ms |
|---|---|
| one repository | **107–216** |
| all 19, sequentially | **2.7 s** |
| all 19, fully parallel | **2.16 s** |

**Parallelism buys about 20%.** Nineteen processes against one disk is disk-bound, not
concurrency-bound, so "just fan it out" does not rescue this. Which is the whole reason the
repository list page reads refs and not `status`: a list that waited for the dirty count would
take two and a half seconds to draw nineteen rows.

`--branch` is what makes the same call answer the current branch, so branch-and-dirty is one
invocation when you do want both.

## 5 — Ref enumeration is not uniformly cheap

On `platform`:

```
git -C platform --no-optional-locks for-each-ref refs/heads
git -C platform --no-optional-locks for-each-ref refs/remotes/origin
```

| what | refs | ms |
|---|---|---|
| `refs/heads` | **3** | **57** |
| `refs/remotes/origin` | **1,264** | **308** |
| both | 1,267 | — |

Three local branches and **1,264** remote-tracking ones on the same repository. So "enumerate the
refs" is two different operations with two different prices, and the list page can afford one of
them per repository and not the other. Locals eagerly; remotes only when something asks.

## 6 — `origin/HEAD`, including where it fatals

```
git -C <repo> --no-optional-locks rev-parse --abbrev-ref origin/HEAD
```

| outcome | repositories |
|---|---|
| resolves | **17 of 19** — `main` ×11, `master` ×6 |
| **fatal** | **2** — `ado-web`, `xshot` |

The two failures are not empty output. They **exit non-zero with a fatal on stderr**, because
those two repositories have **no remotes at all** — there is no `refs/remotes/origin/HEAD` to be
symbolic about. A ladder driven by "did the output come back empty" therefore reads a crash as a
blank and falls through by accident; the ladder must be driven by **exit codes**.

`ado-web` also carries a stray `refs/remotes/local-main` — a remote-tracking ref under no
remote — which is a reminder that `refs/remotes/*` is a namespace and not a promise about
`origin`.

## 7 — What `--raw` prints, and the two defaults that are wrong for us

```
git -C <repo> --no-optional-locks diff --merge-base <target> <branch> --raw -M --abbrev=40 -z
```

Two things the plain form does that were **believed otherwise** until they were looked at, and
neither would have been caught by a hand-written fixture:

- **Object ids are abbreviated to 7 characters** without `--abbrev=40`. Seven hex characters is
  a *prefix*, so a blob cache keyed on it is keyed on luck rather than on content. `--abbrev=40`
  is not a formatting preference here; it is what makes the key a content address.
- **Paths are C-quoted** without `-z` — and only the paths that need it, so a naive parser works
  on every file in the repository until somebody commits one with a space, a quote or a
  non-ASCII character in its name.

`-M` detects renames. `-C` is deliberately **not** passed: `ChangedFile.changeType` has no word
for a copy, so a detected one renders as an add anyway.

**`-M` gives up past `diff.renameLimit` (default 1000) and still exits 0**, with a warning on
**stderr**. Every rename in a large refactor then arrives as an add plus a delete and the page has
nothing to say about it. stderr is captured for this reason.

`--merge-base` on `diff` requires **git ≥ 2.30**; verified working on 2.55.0.
`--no-optional-locks` likewise verified on 2.55.0.

## 8 — Modes, gitlinks, submodules

```
git -C <repo> --no-optional-locks ls-files --stage
```

**Every one of the 14,000+ tracked entries across all 19 repositories is `100644`.** No `100755`,
no `120000` symlink, no `160000` gitlink. And:

```
git -C <repo> --no-optional-locks config --get core.fileMode   →  false, in every repository checked
```

`core.fileMode=false` is the Windows default, and it means **a mode flip cannot be authored on
this machine** — only pulled from somebody whose filesystem has an executable bit. So `100644 →
100755` is a case that must render and cannot be produced locally to look at, which is exactly
the kind of case a hand-typed fixture gets wrong.

Submodules: **0 of 19** have a gitlink or a `.gitmodules`. An absence that was counted, not
assumed — a gitlink is worth recognising from its mode (it names a commit that is not in this
object database, so `cat-file` answers `missing`), and it is not worth a fifth `BlobSide` arm.

## 9 — Line endings

```
git -C <repo> --no-optional-locks ls-files --eol      →  i/lf  w/crlf  attr/text=auto
git config --global core.autocrlf                     →  true
```

**The committed bytes and the bytes on disk differ by design.** `i/lf` is what is in the index,
`w/crlf` is what is in the working tree, and `core.autocrlf=true` is set *globally* on this
machine.

Two consequences:

- A working-tree diff read with `fs.readFile` would report **every line of every file as
  changed**. The deferred working-tree arm has to read through git's own filters, not around
  them.
- A test fixture that inherits these settings passes or fails depending on whose machine ran it.
  Fixtures set `core.autocrlf` and `core.fileMode` **explicitly**, per repository.

---

## What was not measured

Absences, so nothing here reads as more complete than it is.

- **A repository with a submodule, a symlink or an executable bit.** 0 of 19 here, so every
  non-`100644` path in the design is reasoned from git's documented behaviour rather than
  observed.
- **A detached HEAD and an unborn HEAD.** Both are in the contract; neither was found in the
  sample. `rev-parse HEAD` fatalling on a repository with no commits is documented behaviour,
  transcribed rather than seen.
- **A slug collision** — two repositories sharing a basename across two roots. Impossible under
  the default single root, where all 19 basenames are distinct, so the disabled-with-a-reason
  path has never been rendered.
- **A blob over 1 MiB in a local repository.** `MAX_BLOB_BYTES` and the ~10 ms/blob figure were
  measured on different things; nothing here confirms what a megabyte costs through
  `cat-file --batch` specifically.
- **`diff.renameLimit` actually being hit.** The warning's exact text on stderr is *not
  recorded*, so the code that recognises it is matching on a string nobody has seen fire.
- **Anything under a second root.** `ADO_WEB_REPOS_ROOT` is `path.delimiter`-separated by design;
  every number above comes from one root.
- **Cold cache.** Every figure is a warm-cache figure on a machine that had been using these
  repositories all day. A first read after a reboot will be worse and by an unknown factor.
