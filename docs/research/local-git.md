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

---

## Round 7 — history, branches and per-commit diffs

- **Machine:** Windows 11, `C:\Users\PaulDe\repos` as the root.
- **git:** `2.55.0.windows.3`.
- **Taken:** 2026-08-04.

**Every figure below is a warm-cache figure on this machine**, taken while it had been using
these repositories all day, exactly as in §1–§9. A first read after a reboot will be worse by an
unknown factor. Read-only throughout: every invocation is a read, `--no-optional-locks` on all of
them, and nothing here writes a ref, an index or a reflog.

Unlike §1–§9 these were **generated, not transcribed** — a small harness spawned `git` through
`child_process.spawn` with the same environment the server uses (`GIT_TERMINAL_PROMPT=0`,
`LC_ALL=C`, `windowsHide: true`), took five repetitions of every timing and reports the median.
The provenance rule is unchanged: a figure is a measurement, an argv is a recipe, and anything
not recorded is a gap and never a zero.

**The sample has grown.** 19 repositories in round 6, **21** now — `dev-launchpad` and `mcp`
have appeared. Where round 6 said "19", the same fact re-counted today says 21, and the two
numbers are both correct on their own dates. Recounted across all 21:

| fact | count |
|---|---|
| repositories | **21** |
| commits, `rev-list --count --all` summed | **90,792** |
| of those, merges | **23,999** (26.4%) |
| root commits | **37** |
| local branches (`refs/heads`) | **41** |
| remote-tracking refs (`refs/remotes`) | **2,267** |
| tags | **216** |
| shallow clones | **0** |
| bare repositories | **0** |
| `.gitmodules` or gitlink | **0** (unchanged from §8) |
| `refs/notes` / `refs/replace` | **0** / **0** |
| repositories with more than one worktree | **2** — `ado-web` (4), `file-provider` (3) |

## 10 — The commit record, and why the separator is `0x1f`

```
git -C <repo> --no-optional-locks log -z \
  --format=%H%x1f%h%x1f%an%x1f%ae%x1f%cI%x1f%P%x1f%s \
  -n<limit> --end-of-options <rev>
```

Seven fields — full sha, abbreviated sha, author name, author email, committer date
`iso-strict`, the space-separated parent shas, subject — separated by **ASCII US (`0x1f`)** and
terminated per record by **NUL** (`-z`). One record, escaped, verbatim from `ado-web`:

```
"aeedd20d75fa99c46e68bff65bbe480ef6a190e9\u001faeedd20\u001fPaul DeVito\u001f
paul.devito@profisee.com\u001f2026-08-03T14:37:13-04:00\u001f
7ac37f7bad05c4a5f716d34d51961ae54b5a2162\u001f
fix(pr): keep the merge off until the required reviewers approve\u0000"
```

**`-z` terminates, it does not separate.** The last record carries a trailing NUL too, so a split
on NUL yields a final empty element that must be dropped rather than parsed. Verified on a
three-record read: the byte at the end of the stream is `0x00`.

Two separator choices, both justified rather than asserted:

- **NUL between records is safe by construction.** A git commit object cannot contain a NUL
  byte, so `-z` cannot be confused by any message. This was also confirmed by accident: the
  per-repository `-z` record counts matched `rev-list --count --all` **exactly, in all 21
  repositories**, which they could not have done if any message carried a NUL.
- **US between fields is safe by measurement.** Across the sample, **0 of 90,788 fields contain
  US or RS (`0x1e`)**, and 0 raw commit bodies (`%B`) contain either. Confirmed by absence, which
  is weaker than exercised — see *What was not measured*.

Cost, median of five, one branch (`HEAD`) against `--all`:

| repo | `-n 50` | `-n 200` | `-n 1000` | `-n 200 --all` | `-n 1000 --all` |
|---|---|---|---|---|---|
| `ado-web` (102 commits) | **42.9 ms** | 51.1 ms | 48.0 ms | 55.5 ms | 49.0 ms |
| `platform` (51,888 from HEAD) | **40.9 ms** | 54.6 ms | 64.7 ms | 54.3 ms | 71.6 ms |

Baseline spawn on the same run: **51.3 ms** (`ado-web`), **40.1 ms** (`platform`) for
`rev-parse --git-dir`. So **a 50-commit page costs about what an empty spawn costs** — round 6's
§2 finding holds, the price is the process and not the walk. `-n 1000` on `platform` reads
236,080 bytes and still lands at 64.7 ms.

**`--all` is nearly free even on 1,211 remote refs.** `platform` pays +7 ms at `-n 1000` and
nothing measurable at `-n 200`. This is not the §5 result — enumerating the refs is expensive,
*walking from* them is not, because the walk is bounded by `-n` and not by the number of tips.

## 11 — A tab-separated commit format shatters on 2 commits in 90,788

Round 6's `REF_FORMAT` separates `for-each-ref` fields with `%09`. **That idiom does not
generalise to `log`.** The same seven-field record, spelled with tabs, against the US spelling,
on the worst commit in the sample:

```
git -C platform --no-optional-locks log -z -n1 \
  --format=%H%x09%h%x09%an%x09%ae%x09%cI%x09%P%x09%s \
  --end-of-options 9fc402a578a32c6b8c5d3f784ec0e527524ac587
```

| commit | subject chars | tabs in subject | fields, tab format | fields, US format |
|---|---|---|---|---|
| `platform` `9fc402a5` | **46,490** | **1,079** | **1,086** | **7** |
| `BuildTools` `aa04b1cd` | 45,851 | 1,061 | 1,068 | **7** |

Seven expected, **1,086 delivered**. Both are machine-generated resource-string commits whose
message has no blank line after the first line, and that is the mechanism: **`%s` folds the whole
first *paragraph*, not the first line.** Newlines become spaces; **tabs survive.** The raw body
behind `9fc402a5` is 111,399 bytes over 2,568 lines, and `%s` hands all of it back as one field.

The full scan of every commit in the sample:

| what | count of 90,788 |
|---|---|
| a field containing US (`0x1f`) | **0** |
| a field containing RS (`0x1e`) | **0** |
| a raw body (`%B`) containing US or RS | **0** |
| a subject containing a **tab** | **2** |
| a subject containing LF or CR | **0** |
| an author name containing LF | **0** |
| a subject containing non-ASCII | **1,929** |

The 1,929 include emoji with surrogate pairs, ZWJ sequences and VS16, so a subject is UTF-8 and
must be measured in code points and not bytes when it is truncated for display.

The scan read **90,788** commits; the census at the top of this round reads **90,792**. Four
commits landed in the sample between the two runs. Recorded as drift rather than reconciled — the
sample is a working machine, not a fixture.

## 12 — `--skip` is near-flat, and past the end it is silent

```
git -C <repo> --no-optional-locks log -z --format=<fmt> -n50 --skip=<N> --end-of-options HEAD
```

| repo | `--skip=0` | 50 | 500 | 5,000 | 20,000 | 50,000 |
|---|---|---|---|---|---|---|
| `platform` (51,888) | 41.4 ms | 38.1 | 38.5 | 42.1 | 50.7 | **61.8** |
| `matching` (9,156) | 37.8 ms | — | 39.0 | 59.8 | — | — |

**Deep paging costs about 20 ms more than shallow paging**, across 50,000 commits. It is linear
in the offset and the constant is tiny, because the walk is the cheap part. Paging by offset is
therefore fine and does not need a cursor.

**`--skip` past the end of history is 0 bytes with exit 0.** `matching` at `--skip=10000` — 844
past its 9,156 — returns empty and succeeds, in 74.0 ms. So "the page came back empty" cannot
distinguish *past the end* from *no commits*; a total is a separate invocation:

```
git -C platform --no-optional-locks rev-list --count --end-of-options HEAD   →  59.2 ms
git -C platform --no-optional-locks rev-list --count --all                   →  66.9 ms
```

## 13 — The per-commit diff, and what `<sha>^` does to a root commit

Cost, median of five:

| what | ms | bytes |
|---|---|---|
| `diff --raw <sha>^ <sha>` (`platform` HEAD, 2 files) | **52.5** | 245 |
| `diff-tree --root -r --raw` (`platform` HEAD) | **39.7** | 286 |
| `diff-tree --root -r --raw` (`ado-web` HEAD) | **44.0** | 302 |
| `diff --raw` on a 795-file merge against its first parent | 114 | 140,372 |

So a per-commit diff is **another single spawn**, and `diff-tree` is a little cheaper than `diff`
because it is not asked to consider an index.

**`<sha>^` on a root commit is a fatal, not an empty diff.** Verbatim, on `ado-web`'s real root
commit `332a50f1`:

```
fatal: ambiguous argument '332a50f175ee9687e6927eff18cf67f57b35788a^': unknown revision or path not in the working tree.
Use '--' to separate paths from revisions, like this:
'git <command> [<revision>...] -- [<file>...]'
```

exit **128**, stdout empty. `rev-parse --verify <root>^` fails the same way with
`fatal: Needed a single revision`. Reproduced identically on three repositories' roots
(`ado-web`, `platform`, `xshot`). There are **37 root commits** in the sample —
`utilities` has **13**, `file-attachment` **4**, `platform` **2**, and 18 repositories have the
usual 1 — so this is not an exotic case.

Three forms that work, all measured on the same root commits:

| form | root commit | ordinary commit | ms |
|---|---|---|---|
| `diff --raw <empty-tree> <sha>` | works | works | 37.0 |
| `diff-tree --root -r --raw <sha>` | works | works | **38.6** |
| `show --raw --format= <sha>` | works | works | 38–71 |

**`diff-tree --root -r --raw --abbrev=40 -z -M` is the form the server should use.** It is the
only single spelling that needs no branch in the caller: identical argv for a root commit and an
ordinary one, at the same ~40 ms, no second probe to find out which kind it is.

Two details that a parser has to know about it:

- **`diff-tree` prepends the commit sha as its own NUL-terminated token** before the first
  record — `332a50f1…<NUL>:000000 100644 …`. That is why the same diff is 947 bytes through
  `diff-tree` and 906 through `diff`. `parseRaw`'s existing `header.startsWith(':')` guard skips
  it, but a record count taken by splitting on NUL does not.
- **The empty-tree sha `4b825dc642cb6eb9a060e54bf8d69288fbee4904` exists without being
  written.** `cat-file -t` answers `tree` in `ado-web`, `platform` and `xshot`. It is a valid
  left side in any repository, so the empty-tree form needs no setup — it just needs a
  hard-coded constant, which is one more thing to get wrong than `--root`.

## 14 — What a merge commit's diff actually is

**23,999 of 90,792 commits are merges (26.4%)**; on `platform` alone, **15,872 of 56,093
(28.3%)**. There are exactly **2 octopus merges** in the sample, both 3-parent, both on
`platform`. So better than one commit in four hits this path.

Five spellings, on a real 2-parent merge (`platform` `7c37df15`, a
`Merge remote-tracking branch 'origin/master'`) and on a 3-parent octopus (`aa0ad0d3`). Records
are `:`-prefixed raw records:

| spelling | 2-parent: code / bytes / records | octopus: code / bytes / records |
|---|---|---|
| `diff <m>^ <m>` | 0 / 140,372 / **795** | 0 / 11,547 / 69 |
| `diff-tree -r <m>` | 0 / **0** / **0** | 0 / **0** / **0** |
| `diff-tree -r -m <m>` | 0 / 140,980 / 798 | 0 / 46,398 / 275 |
| `diff-tree -r --cc <m>` | 0 / **41** / **0** | 0 / 2,507 / 10 |
| `diff-tree -r --first-parent <m>` | 0 / **0** / **0** | 0 / **0** / **0** |
| `show --raw <m>` | 0 / **0** / **0** | 0 / 2,466 / **10** |
| `show --raw -m <m>` | 0 / 140,898 / 798 | 0 / 46,275 / 275 |
| `show --raw --cc <m>` | 0 / **0** / **0** | 0 / 2,466 / 10 |
| `show --raw --first-parent <m>` | 0 / 140,372 / 795 | 0 / 11,547 / 69 |

**Five of these return an empty diff with exit 0 on a commit that changed 795 files.** Each for a
different reason, and none of them is an error:

- **`diff-tree -r <merge>` with no flag prints nothing at all.** `diff-tree`'s default for a
  merge is to say nothing, and it says it successfully.
- **`--first-parent` is a no-op on `diff-tree`** — it does not turn the default off, so the
  result is still empty. On `show` the same flag works and gives the 795 records. Same word, two
  behaviours, one exit code.
- **`--cc` on a *clean* 2-parent merge is empty by definition.** `--cc` shows only the paths that
  differ from **every** parent, and a merge that resolved without conflict has none. It emits
  **41 bytes** — the sha token and its NUL — so a "did we get any output" check reads it as
  success with content. On the octopus, where 10 paths differ from all three parents, `--cc`
  produces the **combined** format: `:::` and **four** modes and **four** shas. That string
  passes `parseRaw`'s `startsWith(':')` guard and then makes `changeType` throw on the letter
  `1`.
- **`show --raw` with no flag is `--cc`** — which is why it is empty on the 2-parent merge and
  gives the `:::` records on the octopus. The two look like different bugs and are one default.

And `-m`, which does return everything, returns it **wrongly for a page**:

```
show --raw -m:  795 + 3 = 798 records,  140,372 + 526 = 140,898 bytes — exactly the sum
```

**`show --raw -m` concatenates the per-parent diffs with no delimiter whatsoever.** A parser
reading it as one list emits the same path once per parent that touched it. `diff-tree -r -m` at
least emits one NUL-terminated sha token per parent, so the boundaries are recoverable — 798
records and 140,980 bytes, the extra 82 being the two shas.

**What the page can honestly say a merge diff is:** *the change against the first parent* —
`diff-tree --root -r --first-parent` will not give it, but `diff <m>^1 <m>` and
`show --raw --first-parent` both will, and both are what a person reading "what did this merge
bring in" means. It has to be labelled, because it is a choice and not the whole truth: on
`7c37df15` the first parent shows **795** files and the second shows **3**. `--cc` is the honest
answer to a different question ("what did the merge resolution itself change") and costs
**133.6 ms against 49.8 ms** for the first-parent form, roughly 2.7×, plus a second raw format to
parse. First parent, labelled as such.

## 15 — Branch enumeration for a picker

```
git -C <repo> --no-optional-locks for-each-ref \
  --format=%(refname)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(upstream)%1f%(upstream:track)%1f%(HEAD)%1f%(symref)%1f%(subject) \
  --end-of-options refs/heads
```

US-separated for the same reason as §10 — `%(subject)` is the same folded paragraph. What it
answers, verbatim, on `platform`:

```
["refs/heads/backup/aspire-pre-rebase", "1f17d9ea…", "2026-08-03T14:05:07-04:00", "", "", " ", "", "refactor(common): clear analyzer findings on new code"]
["refs/heads/chore/support-aspire-and-containers", "78d154ab…", "2026-08-03T16:19:51-04:00", "refs/remotes/origin/chore/support-aspire-and-containers", "", "*", "", "build(sonar): add opt-in SonarAnalyzer.CSharp analyzer package"]
["refs/heads/master", "bb939263…", "2026-07-31T14:20:09Z", "refs/remotes/origin/master", "[behind 167]", " ", "", "Updated resx files [skip ci]"]
```

Three traps in that output, none of which is visible from the documentation:

- **`%(HEAD)` is `*` or a single space**, never empty. A field test of `=== ''` finds no current
  branch anywhere.
- **`%(upstream:track)` is a pre-formatted English string** — `[behind 167]`, `[gone]` — and it
  is **empty both for "in sync" and for "no upstream configured"**. 13 of the 41 local branches
  in the sample have no upstream at all, so the empty string is the common case and it means two
  different things. `%(upstream)` being empty is what distinguishes them; both fields are needed.
- **`%(committerdate:iso-strict)` is in the committer's own offset**, not normalised —
  `2026-08-03T14:05:07-04:00` on one row and `2026-07-31T14:20:09Z` on the next, in the same
  repository. Sortable as an instant only after parsing.

Cost. The picker format is **free** relative to round 6's four-field one; the ahead/behind field
is not:

| repo | refs | round 6 format | picker format | `+%(ahead-behind:HEAD)` |
|---|---|---|---|---|
| `ado-web` `refs/heads` | 4 | 42.8 ms | 35.3 ms | 38.1 ms |
| `platform` `refs/heads` | 4 | 38.9 ms | 38.7 ms | 41.0 ms |
| `matching` `refs/remotes` | 324 | 40.2 ms | 49.5 ms | **232.5 ms** |
| `platform` `refs/remotes` | 1,211 | 72.2 ms | **71.0 ms** | **613.5 ms** |

**`%(ahead-behind:<committish>)` is not free — it is 8.6× on `platform` and 4.7× on
`matching`.** It is free on `refs/heads` only because there are never more than four of them. It
needs git ≥ 2.41; working on 2.55.0.

The alternative, per branch and on demand:

```
git -C platform --no-optional-locks rev-list --left-right --count --end-of-options refs/heads/master...HEAD   →  40.9 ms
```

**One spawn is 40.9 ms**, so ahead/behind for a *handful* of branches is cheaper one at a time
than as a field over the whole namespace. Cheaper as a field only past about a dozen refs — and
`refs/heads` never has a dozen here.

Branch counts, all 21:

| repo | `refs/heads` | `refs/remotes` | tags |
|---|---|---|---|
| `BuildTools` | 1 | 17 | 14 |
| `ado-web` | 4 | 1 | 0 |
| `auth` | 3 | 48 | 15 |
| `chatbot` | 1 | 24 | 4 |
| `connex` | 1 | 113 | 11 |
| `data` | 1 | 52 | 12 |
| `dev-launchpad` | 3 | **0** | 0 |
| `dev-utilities` | 1 | 62 | 1 |
| `file-attachment` | 2 | 35 | 20 |
| `file-provider` | 3 | 17 | 15 |
| `governance` | 1 | 42 | 16 |
| `matching` | 1 | 324 | 12 |
| `mcp` | 1 | 11 | 2 |
| `monitor` | 1 | 49 | 10 |
| `platform` | 4 | **1,211** | 41 |
| `proflow` | 2 | 32 | 2 |
| `rest-api` | 2 | 125 | 22 |
| `script-runner` | 2 | 13 | 2 |
| `taskman` | 2 | 18 | 2 |
| `utilities` | 3 | 73 | 15 |
| `xshot` | 2 | **0** | 0 |
| | **41** | **2,267** | **216** |

**Never more than four local branches, and up to 1,211 remote-tracking ones.** A picker over
`refs/heads` is always small; a picker over `refs/remotes` is a 1,211-row list on the repository
someone is most likely to open. §5's conclusion — locals eagerly, remotes on demand — is
reconfirmed, and the picker needs a filter box rather than a scroll bar.

One correction to §5, offered rather than buried: **`platform`'s `refs/remotes` re-measures at
1,211 refs in 71.0 ms today, where §5 recorded 1,264 in 308 ms.** The ref count moved because
the sample is live; the 4× time difference is not explained by 53 refs and is more likely
`for-each-ref` reading a packed-refs file that has since been repacked. §5's shape conclusion
stands, its 308 ms does not reproduce.

## 16 — Resolving a request's sha, and the flag that echoes itself

```
git -C <repo> --no-optional-locks rev-parse --verify --end-of-options <value>^{commit}
```

**35.1 ms** for a hit, **33.0 ms** for a miss, `cat-file -t` for comparison **32.9 ms**. Every
case the brief asked for, on `platform`:

| case | value | code | stdout | stderr |
|---|---|---|---|---|
| (a) full sha | `78d154ab…^{commit}` | **0** | the 40-hex sha | — |
| (b) 7-hex abbrev | `78d154a^{commit}` | **0** | the full 40-hex sha | — |
| (b) 4-hex abbrev | `78d1^{commit}` | **128** | — | `error: short object ID 78d1 is ambiguous` |
| (c) 40-hex not in the ODB | `000…001^{commit}` | **128** | — | `fatal: Needed a single revision` |
| (c) the same, **without** `^{commit}` | `000…001` | **0** | **`000…001`** | — |
| (d) a tree | `63dbfe2e…^{commit}` | **128** | — | `error: …: expected commit type, but the object dereferences to tree type` |
| (d) the same, **without** `^{commit}` | `63dbfe2e…` | **0** | **the tree sha** | — |
| (e) `--help` | `--help` | 128 | — | `fatal: Needed a single revision` |
| (e) `--output=C:/…/pwned.txt` | | 128 | — | `fatal: Needed a single revision` |
| (f) an existing branch name | `master^{commit}` | **0** | its tip sha | — |
| (f) a branch that does not exist | `main^{commit}` | 128 | — | `fatal: Needed a single revision` |

**`^{commit}` is the load-bearing part, not `--verify`.** Without it, a well-formed 40-hex string
that is not in the object database and a *tree* sha **both come back exit 0 with the input echoed
back**. `--verify` verifies that the argument *parses as a revision*, not that it names a commit
that exists. `--verify --quiet` on the absent 40-hex also **exits 0 and echoes it**. So a
validator built on `--verify` alone blesses a sha that nothing can diff, and the failure surfaces
one call later as `fatal: bad object 0000…0001` from `diff`.

**`--quiet` makes the failure wordless, not silent.** `--verify --quiet <absent>^{commit}` is
**exit 1 with completely empty stderr**. A ladder must read the code; there is nothing to match a
string against.

**`git rev-parse --end-of-options HEAD` prints `--end-of-options` as its own first line of
stdout, exit 0** — `"--end-of-options\n78d154ab…\n"`. This is not theory: it corrupted a batch of
these measurements before it was noticed, because `.stdout.trim()` produced a two-line "sha" and
every downstream `diff` then failed with
`fatal: option '--end-of-options\n<sha>' must come before non-option arguments`. **`--verify`
suppresses the echo.** `local-git.ts` already notes this for `--show-toplevel`; it is a property
of `rev-parse` in general, and the rule is that `rev-parse` is only ever spelled with `--verify`.

`--end-of-options` does its job on the dash cases regardless — but so does `rev-parse` without
it, because `--help` and `--output=…` are simply not revisions. The protection matters for
subcommands where they *are* valid flags, which is why `gitArgs` refuses a leading dash in an
operand **as well as** passing the flag.

**Is resolve-then-use a substitute for enumeration? No — it is a substitute for quoting.**
Resolving first and passing the *resolved 40-hex* onward is sound and worth doing: it turns any
accepted input into a canonical sha and removes every ambiguity from the argv. But it does not
constrain *what* the user may name, because the revision grammar is a query language:

| value | code | resolves to |
|---|---|---|
| `HEAD~5^{commit}` | 0 | an ancestor five back |
| `HEAD@{1}^{commit}` | **0** | **whatever the reflog's previous position was** |
| `:/fix` | **0** | **the newest commit whose message matches `fix`** |
| `78D154AB…^{commit}` (uppercase) | 0 | the lowercase sha |
| `HEAD@{999}` | 128 | `fatal: log for 'HEAD' only has 100 entries` |

`:/fix` is a commit-message search and `@{1}` is a reflog read; both succeed, both return a real
commit, and neither is a sha. `HEAD@{999}`'s fatal **reports the reflog's length**. None of this
is a route out of the repository — the object database is the boundary and every answer is a
commit inside it — but a field documented as "a sha" accepts a search expression, so it should be
**validated against `/^[0-9a-f]{40}$/i` before git ever sees it** and resolved afterwards. Two
checks, because they refuse two different things.

## 17 — What fatals rather than returning empty

§6 found that `origin/HEAD` crashes where a ladder expected a blank. The same question, asked of
every call this round needs:

| invocation | code | stdout | stderr |
|---|---|---|---|
| `for-each-ref refs/heads/nope` | **0** | empty | — |
| `for-each-ref refs/nonexistent` | **0** | empty | — |
| `for-each-ref --format=%(nosuchfield)` | 128 | — | `fatal: unknown field name: nosuchfield` |
| `for-each-ref …%(ahead-behind:refs/heads/nope)` | **128** | — | `fatal: failed to find 'refs/heads/nope'` |
| `log --skip=999999` | **0** | **empty** | — |
| `log -n0` | **0** | **empty** | — |
| `log <absent 40-hex>` | 128 | — | `fatal: bad object 0000…0001` |
| `log refs/heads/nope` | 128 | — | `fatal: ambiguous argument …` |
| `log <tree sha>` | **0** | **empty** | **—** |
| `rev-list --count refs/heads/nope` | 128 | — | `fatal: ambiguous argument …` |
| `diff-tree -r <tree sha>` | **0** | **empty** | **`error: object 63dbfe2e… is a tree, not a commit`** |
| `diff-tree --root -r <absent 40-hex>` | 128 | — | `fatal: bad object 0000…0001` |
| `diff-tree --root -r <annotated tag sha>` | **0** | **empty** | **—** |
| `diff-tree --root -r --cc <non-merge>` | 0 | 286 bytes, normal | — |

Four of these are worse than a fatal:

- **`diff-tree -r <tree sha>` exits 0 while printing `error:` to stderr.** An error message under
  a success code — the exact inverse of §6. A ladder keyed on the exit code passes it; a ladder
  keyed on stderr being empty fails a call that succeeded. Neither test is sufficient alone.
- **`git log <tree sha>` is 0 bytes, exit 0, and nothing on stderr at all.** A tree sha where a
  commit was expected produces a blank page with no evidence anywhere that anything went wrong.
- **`%(ahead-behind:<ref>)` against a ref that has been deleted fatals the whole
  enumeration** — 128, no rows. The picker does not lose one column; it loses every branch.
  Which is a second reason to compute ahead/behind per branch on demand.
- **An annotated tag's sha diffs to nothing, silently.** `platform` has 41 tags, **40 of them
  `tag` objects**. `rev-parse --verify` on `refs/tags/2021.R2`'s objectname returns
  `6c518bb9…` — **the tag object**, not a commit — and `^{commit}` peels it to a *different* sha,
  `7d631ae1…`. `git log 6c518bb9…` peels it for you and walks correctly; **`diff-tree --root -r
  6c518bb9…` returns 0 bytes, exit 0, empty stderr.** So `log` and `diff-tree` disagree about
  whether a tag sha is a commit, and the one that disagrees does so without saying anything.
  `^{commit}` on the way in fixes all of it.

The rule that falls out, and it is stronger than §6's: **read the exit code, and treat empty
output as data rather than as a signal.** Every genuinely-empty case in this table — `--skip` past
the end, `-n0`, a namespace with no refs, a clean `--cc` merge — is indistinguishable from the
failure cases by output alone, and two of the failures are indistinguishable by exit code alone.
A count, or a resolution through `^{commit}`, has to be asked separately.

---

## What was not measured — round 7

- **A commit whose message or author name contains US or RS.** 0 of 90,788. The separator choice
  in §10 is **confirmed by absence, not exercised** — nothing in this sample would have caught it
  had the choice been wrong. The tab result in §11 is the exercised one.
- **A merge with more than three parents.** Only 2 octopus merges exist and both are 3-parent, so
  the `:::` combined format was read at 4 modes and 4 shas and never wider.
- **A conflicted 2-parent merge.** `--cc` was empty on the one measured because it resolved
  cleanly. A 2-parent merge that *does* produce combined records was not found, so `--cc`'s
  2-parent output shape is transcribed from the octopus rather than seen at two parents.
- **A shallow clone.** 0 of 21 (`rev-parse --is-shallow-repository` false everywhere), so what
  `log` and `<sha>^` do at a graft boundary is unmeasured — and a grafted parent is the one other
  way `<sha>^` fails on a commit that has a parent.
- **A bare repository.** 0 of 21.
- **A detached or unborn HEAD.** Still 0, as in round 6. `log` and `rev-list` against an unborn
  HEAD remain documented behaviour rather than observed.
- **A submodule or gitlink.** Still 0 of 21, so §8's absence carries forward unchanged into the
  per-commit diff.
- **`diff.renameLimit` firing on a *per-commit* diff.** §7 records that it exits 0 with a
  warning; the largest per-commit diff read this round was 795 files, under the default 1,000,
  so the warning has still never been seen fire.
- **`refs/notes` and `refs/replace`.** 0 of 21, so a replaced or annotated commit's history is
  not represented here.
- **Whether a commit-graph file exists per repository.** The path was queried and the answer was
  **not recorded**. A gap, not a zero — and it matters, because a commit-graph is exactly what
  would make §10's `--all` and §12's deep `--skip` as cheap as they measured.
- **The three orphaned `node_modules` directories at the root** are now named
  `ado-web-t016-blobs`, `ado-web-t017-diff` and `ado-web-t019-highlight` — leftovers of deleted
  worktrees, each containing nothing but `node_modules`, each answering `rev-parse` with
  `fatal: not a git repository`. They are correctly excluded by §1's census rule, and no
  measurement here covers what a *stale* worktree pointer (a `.git` file naming a deleted gitdir)
  would do, because none survived.
- **Cold cache.** As in round 6, and worth repeating because this round's headline is that the
  cost is the spawn: every figure is warm. The ~40 ms floor is a warm-cache floor.
- **Anything under a second root.** Unchanged from round 6.
