---
date: 2026-06-12T23:49:17+0900
author: Yuku Kotani
commit: b746064
branch: main
repository: pi-memory-dreaming
topic: "pi-session-dreaming-memory-maintenance"
tags: [research, codebase, pi-dreaming, memory, markdown]
status: ready
last_updated: 2026-06-12T23:49:17+0900
last_updated_by: Yuku Kotani
---

# Research: pi-session-dreaming-memory-maintenance

## Research Question
`.rpiv/artifacts/discover/2026-06-12_23-37-59_pi-session-dreaming-memory-maintenance.md` からの連鎖調査。既存の pi extension と `/dreaming` lifecycle seam を保ちつつ、canonical JSON-store synthesis path を Markdown-backed Dream maintenance workflow に置き換え、current pi session digest と既存 Markdown memories を読み、安全に自動保存される memory edits、index/link 構造、次回 agent turn への recall を成立させるには、現行コードのどこをどう理解すべきか。

## Summary
現行のユーザー向け seam は狭く、`package.json` の pi extension 登録、`extensions/pi-dreaming/index.ts` の default export、`/dreaming` command、lifecycle hook を維持したまま、内部の store / prompt / synthesis / apply 層を置き換えられる。現在の実装は `.pi/dreaming/memories.json` を canonical store とする 1-pass JSON synthesis で、Markdown frontmatter、stable slug/name/description、`[[slug]]` links、`_index.md` は未実装。session input は current pi branch 由来の user/assistant text と assistant tool call 引数に限定され、provenance は `SourceDigest` として保存されるが、full transcript は永続化されない。最も重要な設計注意点は、現行 safety が forbidden/sensitive/low-confidence を active にしないだけで candidate としては保存し得るため、常時自動保存の Markdown 版では「normal のみ保存、secret/forbidden/sensitive/low-confidence は保存しない」境界へ強める必要がある点。

## Detailed Findings

### Extension seam and lifecycle
- Package entry は `package.json:24-26` の `pi.extensions` による `./extensions/pi-dreaming/index.ts` 登録で、runtime entry は `extensions/pi-dreaming/index.ts:8-10` の default export が `/dreaming` command と lifecycle を登録するだけの狭い seam。
- Lifecycle state は `extensions/pi-dreaming/index.ts:13-18` の `ctxRef` / timer / `running` / `generation` / `lastObservedSignature` で管理され、`cleanup()` が session replacement 時の stale async work を避けるために `generation` を進める（`extensions/pi-dreaming/index.ts:20-28`）。
- `session_start` は即時 dream ではなく `activateSession()` と timer 開始だけを行う（`extensions/pi-dreaming/index.ts:68-70`, `extensions/pi-dreaming/index.ts:31-43`）。
- timer と `agent_end` は `attemptDream()` に合流し、digest signature の timer dedupe と concurrency guard 後に `runDreaming(ctx, { reason })` を呼ぶ（`extensions/pi-dreaming/index.ts:47-59`, `extensions/pi-dreaming/index.ts:84-86`）。
- `before_agent_start` は store を読み、active memories から recall prompt を作り、`event.systemPrompt` に追記する（`extensions/pi-dreaming/index.ts:72-81`）。Markdown recall もこの返却 shape を保つのが最小変更点。

### Session digest input and provenance
- `runDreaming()` は store setting の `maxDigestChars` を使って `buildSessionDigest(ctx, ...)` を呼び、skip 判定と prompt input の両方に同じ digest を使う（`extensions/pi-dreaming/dreamer.ts:60-61`）。
- `buildSessionDigest()` は branch entries を text 化し、末尾から truncate し、`sessionKey` / `signature` / `messageCount` / `excerpt` / `capturedAt` / transient `text` / `charCount` を返す（`extensions/pi-dreaming/session.ts:26-41`）。
- branch source は `ctx.sessionManager.getBranch()`（`extensions/pi-dreaming/session.ts:55-57`）、session provenance は `ctx.sessionManager.getSessionFile()` または `memory:${ctx.cwd}` fallback（`extensions/pi-dreaming/session.ts:64-66`）。
- Transcript fidelity は user/assistant roles の text blocks と assistant `toolCall` name/arguments に限定される（`extensions/pi-dreaming/session.ts:73-86`, `extensions/pi-dreaming/session.ts:97-116`）。tool result、system/developer messages、non-text blocks は含まれない。
- `SourceDigest` は `sessionKey`、`signature`、`messageCount`、`excerpt`、`capturedAt` の永続 provenance contract で、full `digest.text` は保存されない（`extensions/pi-dreaming/types.ts:9-20`, `extensions/pi-dreaming/session.ts:21-23`）。

### Current JSON store and schema
- Canonical memory schema は `DreamingMemory` の `id` / `kind` / `content` / `status` / `confidence` / `sensitivity` / metadata / `sources`（`extensions/pi-dreaming/types.ts:22-35`）。store は `DreamingStore` の `version` / `settings` / `memories` / optional `lastRun`（`extensions/pi-dreaming/types.ts:57-62`）。
- Store path は `extensions/pi-dreaming/store.ts:16` の `.pi/dreaming/memories.json` 固定で、README もこの JSON store と `0600` を公開仕様としている（`README.md:52-53`）。
- `loadDreamingStore()` は missing file なら default、parse/normalize failure でも warning 後に default を返す（`extensions/pi-dreaming/store.ts:44-54`）。
- `saveDreamingStore()` は normalize 済み JSON を same-dir temp file に書き、rename 後に best-effort chmod する（`extensions/pi-dreaming/store.ts:57-83`）。Markdown 複数ファイル更新では、この single-file atomicity より広い failure boundary が必要。
- Identity は stable slug ではなく `id` または `makeMemoryId(content)` による content hash（`extensions/pi-dreaming/store.ts:86-92`, `extensions/pi-dreaming/store.ts:149-156`）。dedupe は `id` ごとに新しい `updatedAt` を残す（`extensions/pi-dreaming/store.ts:210-218`）。
- Active recall は `status === "active"` を confidence desc / `updatedAt` desc で sort する（`extensions/pi-dreaming/store.ts:95-99`）。`lastUsedAt` は保存されるが ordering には使われない（`extensions/pi-dreaming/types.ts:34`, `extensions/pi-dreaming/store.ts:162-185`）。

### Synthesis pipeline
- `runDreaming()` は disabled / unchanged / too-small / no-model / auth failure を preflight で処理し、その後 `complete()` に strict JSON prompt を投げる（`extensions/pi-dreaming/dreamer.ts:42-142`）。
- System prompt は strict JSON only と non-markdown を要求し、secret 保存禁止と sensitive domain marking を指示する（`extensions/pi-dreaming/prompts.ts:4-8`）。Markdown maintenance へはこの prompt contract 自体の差し替えが必要。
- User prompt は active/candidate memories と `<conversation_digest session=... signature=...>` を含め、output shape を `{"memories":[...]}` の upsert/archive/ignore JSON として固定している（`extensions/pi-dreaming/prompts.ts:26-51`）。
- Parsing は response text から JSON object を抜き、`memories` array の plain object だけを candidate とする（`extensions/pi-dreaming/dreamer.ts:334-357`）。
- Applying は `ignore` skip、`archive` で existing memory status 更新、`upsert` で normalized candidate を active/candidate として store に挿入または上書きする（`extensions/pi-dreaming/dreamer.ts:204-264`）。
- Provenance merge は同じ signature を除去して current digest を先頭にし、最大 8 sources に制限する（`extensions/pi-dreaming/dreamer.ts:367-369`）。

### Safety boundary
- Secret regex は key/value credentials、private key PEM、`sk-...` token、JWT-like token を検出する（`extensions/pi-dreaming/dreamer.ts:27-32`）。`containsSecret()` は任意 text に対してこの regex set を適用する（`extensions/pi-dreaming/dreamer.ts:372-373`）。
- `normalizeCandidate()` は content に secret があれば `sensitivity = "forbidden"` に強制する（`extensions/pi-dreaming/dreamer.ts:286-300`）。
- `shouldAutoSave()` は malformed、`sensitivity !== "normal"`、低 confidence、secret match を active 化しない（`extensions/pi-dreaming/dreamer.ts:268-272`）。
- ただし現行 `applySynthesis()` は auto-save 不可の item を `candidate` として count し、dry-run でなければ store に保存する（`extensions/pi-dreaming/dreamer.ts:226-261`）。つまり現行保証は「active にしない」であり、「ディスクへ保存しない」ではない。
- `/dreaming approve` は forbidden candidate の active 昇格を拒否する（`extensions/pi-dreaming/commands.ts:84-92`）。Markdown 版で candidate/approval を廃止するなら、この後段 guard の代わりに write 前の drop policy が必要。

### Command UX
- `/dreaming` dispatch は `status` / `list` / `show` / `forget` / `approve` / `reject` / `enable` / `disable` / `run` を持つ（`extensions/pi-dreaming/commands.ts:15-28`）。
- Manual run は `ctx.waitForIdle()` 後、`--dry-run` と `--force` を解析し、dry-run は force も implied して `runDreaming(ctx, { reason: "manual", dryRun, force: force || dryRun })` を呼ぶ（`extensions/pi-dreaming/commands.ts:33-39`）。
- `DreamingRunOptions` は `reason`、optional `force`、optional `dryRun`（`extensions/pi-dreaming/types.ts:82-86`）。`runDreaming()` 側で force は disabled/skip bypass、dry-run は apply/save skip に効く（`extensions/pi-dreaming/dreamer.ts:46-61`, `extensions/pi-dreaming/dreamer.ts:174-186`, `extensions/pi-dreaming/dreamer.ts:396`）。
- `formatStatus()` は enabled、active/candidate/archived counts、interval、autoSaveMinConfidence、lastRun を出す（`extensions/pi-dreaming/commands.ts:42-54`）。Markdown 版でも `/dreaming status` は維持対象。
- `formatList()` と `formatShow()` は JSON memory id/status/kind/confidence/content と JSON.stringify に依存する（`extensions/pi-dreaming/commands.ts:57-72`）。Markdown slug/name/description/body への表示設計が必要。
- Developer checkpoint により `approve` / `reject` は完全削除方針。README の command list も合わせて更新対象（`README.md:60-68`）。

### Durable write behavior
- 現行 durability は `.pi/dreaming/memories.json` 単一ファイルを same-dir temp path に書いて rename する設計（`extensions/pi-dreaming/store.ts:57-66`）。失敗時は temp unlink best-effort と warning、`false` return（`extensions/pi-dreaming/store.ts:67-75`）。
- chmod failure は保存失敗扱いにしない（`extensions/pi-dreaming/store.ts:77-82`）。fsync は実装されていない。
- `finishRun()` は completed/skipped/failed の共通出口で、`lastRun` を作り、signature があれば保存し、`saveDreamingStore()` failure を run failure に変換する（`extensions/pi-dreaming/dreamer.ts:380-400`）。
- Markdown memories、`_index.md`、rename/consolidation、links を複数ファイル更新する場合、index と memory files の整合性、partial write、rename/delete ordering を current single-file design より明示する必要がある。

## Code References
- `package.json:24-26` — pi extension entrypoint registration.
- `package.json:29-31` — `bun run check` script and dry-run pack script.
- `README.md:38-53` — automatic behavior, recall, synthesis timing, current JSON storage docs.
- `README.md:55-68` — current `/dreaming` management command surface.
- `extensions/pi-dreaming/index.ts:8-13` — extension default export and lifecycle registration seam.
- `extensions/pi-dreaming/index.ts:37-45` — timer setup from store settings.
- `extensions/pi-dreaming/index.ts:47-65` — `attemptDream()` dedupe/concurrency/run path.
- `extensions/pi-dreaming/index.ts:68-90` — lifecycle hook registration.
- `extensions/pi-dreaming/commands.ts:8-12` — `/dreaming` command registration.
- `extensions/pi-dreaming/commands.ts:15-28` — subcommand dispatch.
- `extensions/pi-dreaming/commands.ts:33-39` — manual run, `--dry-run`, `--force` behavior.
- `extensions/pi-dreaming/commands.ts:42-72` — status/list/show JSON-oriented formatting.
- `extensions/pi-dreaming/commands.ts:84-102` — approve/reject candidate flow to remove under the chosen design.
- `extensions/pi-dreaming/session.ts:26-41` — session digest construction.
- `extensions/pi-dreaming/session.ts:45-48` — unchanged/min-size skip logic.
- `extensions/pi-dreaming/session.ts:55-66` — branch and session file access.
- `extensions/pi-dreaming/session.ts:73-86` — conversation text construction from message entries.
- `extensions/pi-dreaming/session.ts:97-123` — text/tool-call extraction and tail truncation.
- `extensions/pi-dreaming/types.ts:9-20` — `SourceDigest` provenance contract.
- `extensions/pi-dreaming/types.ts:22-35` — current `DreamingMemory` schema.
- `extensions/pi-dreaming/types.ts:57-62` — current `DreamingStore` schema.
- `extensions/pi-dreaming/types.ts:82-95` — run options and result counters.
- `extensions/pi-dreaming/store.ts:16` — current JSON store path.
- `extensions/pi-dreaming/store.ts:44-83` — load/save JSON store behavior.
- `extensions/pi-dreaming/store.ts:86-99` — content-hash identity and active selection.
- `extensions/pi-dreaming/store.ts:149-188` — memory normalization.
- `extensions/pi-dreaming/store.ts:210-218` — dedupe by id.
- `extensions/pi-dreaming/dreamer.ts:27-32` — secret detection regex set.
- `extensions/pi-dreaming/dreamer.ts:42-202` — run orchestration and model call.
- `extensions/pi-dreaming/dreamer.ts:204-264` — JSON synthesis apply path.
- `extensions/pi-dreaming/dreamer.ts:268-300` — auto-save and candidate safety handling.
- `extensions/pi-dreaming/dreamer.ts:334-357` — JSON response parser.
- `extensions/pi-dreaming/dreamer.ts:367-373` — source merge and secret detection.
- `extensions/pi-dreaming/dreamer.ts:380-400` — lastRun/save common exit path.
- `extensions/pi-dreaming/prompts.ts:4-8` — current strict JSON + safety system prompt.
- `extensions/pi-dreaming/prompts.ts:10-23` — recall system prompt builder.
- `extensions/pi-dreaming/prompts.ts:26-63` — current JSON synthesis user prompt and memory formatting.

## Integration Points

### Inbound References
- `package.json:24-26` — pi runtime discovers and loads `./extensions/pi-dreaming/index.ts`.
- `extensions/pi-dreaming/index.ts:8-10` — extension initializer calls command and lifecycle registration.
- `extensions/pi-dreaming/commands.ts:8-12` — pi command registry invokes `handleDreamingCommand()` for `/dreaming`.
- `extensions/pi-dreaming/index.ts:68-90` — pi lifecycle events invoke session activation, recall, background dreaming, and cleanup.
- `README.md:38-68` — public UX contract for automatic behavior and commands.

### Outbound Dependencies
- `extensions/pi-dreaming/session.ts:55-66` — depends on `ctx.sessionManager.getBranch()` and `ctx.sessionManager.getSessionFile()` for current pi session input.
- `extensions/pi-dreaming/dreamer.ts:93-141` — depends on `ctx.modelRegistry.getApiKeyAndHeaders()` and `complete()` from `@earendil-works/pi-ai` for model synthesis.
- `extensions/pi-dreaming/store.ts:1-3` — depends on Node fs/path/crypto primitives for JSON persistence and identity hashing.
- `extensions/pi-dreaming/index.ts:58-59` and `extensions/pi-dreaming/commands.ts:126-129` — optionally depend on UI notification availability via `ctx.hasUI` / `ctx.ui.notify`.

### Infrastructure Wiring
- `package.json:29-31` — verification uses `bun run check` (`tsc --noEmit`) and packaging dry run.
- `extensions/pi-dreaming/store.ts:18-26` — default settings wire interval, min digest chars, max digest chars, recall limit, auto-save threshold, candidate max age.
- `extensions/pi-dreaming/index.ts:37-45` — timer interval is loaded from store settings at session activation.
- `extensions/pi-dreaming/prompts.ts:10-23` + `extensions/pi-dreaming/index.ts:72-81` — recall wiring joins memory formatting with `before_agent_start` system prompt mutation.
- `extensions/pi-dreaming/dreamer.ts:380-400` + `extensions/pi-dreaming/store.ts:107-108` — run result wiring persists `lastRun` for skip/status behavior.

## Architecture Insights
- The safe architectural seam is below `index.ts` and command registration: keep extension loading, lifecycle hooks, and `/dreaming run/status` stable while replacing store, prompt, parser, and apply mechanics.
- Current `DreamingMemory` is both storage schema and recall view. Markdown migration should separate durable Markdown document representation from the smaller recall projection consumed by `buildRecallSystemPrompt()`.
- `SourceDigest` is a reusable provenance unit for Markdown frontmatter or embedded metadata, but it does not include full transcript. Verification claims should not assume durable replay unless Markdown workflow explicitly stores enough context or re-reads current session.
- Current skip logic depends on `lastRun.signature`. If `.pi/dreaming/memories.json` disappears entirely, equivalent run metadata must still exist somewhere durable, or timer/manual skip semantics change.
- Current safety model is insufficient for always-auto-save because it can persist forbidden/sensitive candidates. The researched design should filter before any Markdown write and only save normal, sufficiently trusted memory facts.
- Current `approve` / `reject` commands are semantically coupled to candidates. Developer checkpoint chose full removal, so docs, usage, dispatch, and any candidate counters should be simplified rather than preserved as deprecated compatibility.
- Single-file atomic rename is simple; Markdown maintenance introduces multi-file transaction concerns. The planner should explicitly preserve existing files on failed synthesis/write and avoid an `_index.md` that points to files not successfully written.

## Precedents & Lessons
2 similar past changes analyzed.

### Precedent: Initial pi-dreaming JSON-store memory extension
**Commit(s)**: `8a96951` — "add pi dreaming package" (2026-06-08)  
**Blast radius**: 9 files across 6 layers
  extension/lifecycle/ — command registration, session hooks, recall, auto-run after agent/timer
  command/UX/ — `/dreaming` status/list/show/run/approve/reject/forget/enable/disable
  session/ — current pi branch digest via `ctx.sessionManager`
  dreamer/prompt/ — single `complete()` JSON synthesis with safety prompt
  store/domain/ — `.pi/dreaming/memories.json`, memory schema, active/candidate/archive statuses
  packaging/docs/ — pi extension registration and README behavior docs

**Follow-up fixes**:
- None found for `extensions/pi-dreaming` after `8a96951`.

**Lessons from docs**:
- `.rpiv/artifacts/discover/2026-06-12_23-37-59_pi-session-dreaming-memory-maintenance.md` — keep pi extension and `/dreaming` lifecycle; use current pi session rather than ant sessions; replace JSON synthesis with Markdown memory maintenance; preserve recall; never save secrets.

**Takeaway**: The main implementation risk is changing storage/synthesis core while accidentally breaking the existing lifecycle and recall seam.

### Precedent: Packaging/release flow after pi-dreaming package
**Commit(s)**: `aa372fb` — "add npm trusted publishing release flow" (2026-06-08)  
**Blast radius**: 3 files across 2 layers
  packaging/ — packageManager, repository, publishConfig metadata
  ci-release/ — release PR and npm publish workflows with `bun run check` and pack dry-run

**Follow-up fixes**:
- `0145cc6` — "chore: release v0.2.0" (2026-06-08) — package version/metadata adjusted for release.
- `b746064` — "README" (2026-06-08) — install docs corrected from local-only path to npm plus local-dev variants.

**Lessons from docs**:
- `.rpiv/artifacts/discover/2026-06-12_23-37-59_pi-session-dreaming-memory-maintenance.md` — package registration already exposes `./extensions/pi-dreaming/index.ts`; do not add standalone CLI/API.

**Takeaway**: If package or README changes, keep npm install docs and `pi.extensions` registration aligned with the extension entrypoint.

### Composite Lessons
- Preserve `/dreaming` and lifecycle hooks first; all relevant history centers on that seam.
- Markdown migration has no prior fix history, so verification must explicitly cover forced run, Markdown creation/update, index creation, and recall on a later agent turn.
- Always-auto-save requires stronger write-time safety than the current candidate model.
- Update README command/storage docs alongside code changes, and run `bun run check` before release.

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/discover/2026-06-12_23-37-59_pi-session-dreaming-memory-maintenance.md` — source FRD for pi session Dream-like Markdown memory maintenance.

## Developer Context
**Q (discover: Foundational Intent): Claude Managed Agents の Dream と同等の仕組みを、このリポジトリで実現したい背景として、いま誰がどんな問題に当たっていて、成功するとその人に何が起きますか？**  
A: 利用者向け

**Q (discover: User-Facing Entry): プローブから、既存の利用者向け入口は pi 拡張の `/dreaming` コマンドと lifecycle で、standalone CLI/API はありません（package.json:24-31、extensions/pi-dreaming/commands.ts:8-28）。この前提を維持しますか？**  
A: 維持する

**Q (discover: Session Input Source): プローブから、既存実装は現在の pi セッション branch を digest 化しており、`ant beta:sessions retrieve` のような外部セッション取得/zip入力はありません（extensions/pi-dreaming/session.ts:26-31、55-67）。Dream 互換としてどちらを要件にしますか？**  
A: ant sessionを使いたいわけじゃない。pi sessionに対して同じようなdreaming処理をしたいということ

**Q (discover: Output Artifact Scope): プローブから、成果物は `.pi/dreaming/memories.json` に集約され、run ごとの artifact/log/report はありません（README.md:52-53、extensions/pi-dreaming/store.ts:16、57-83）。確認体験はどうしますか？**  
A: メモリだけ残っていれば十分。でも memories.json という形式じゃなくてもいい

**Q (discover: Goal Depth): この FRD の主ゴールは、pi session に対してどの粒度で Managed Agents Dream 風の処理を再現することにしますか？**  
A: 記憶保守まで

**Q (discover: Processing Shape): 既存は 1 回の `complete()` で JSON のメモリ更新案を作る形です（extensions/pi-dreaming/dreamer.ts:123-174、extensions/pi-dreaming/prompts.ts:26-50）。Managed Agents Dream 風に寄せる処理形状はどれにしますか？**  
A: 保守ワークフロー化

**Q (discover: Memory Storage Format): メモリだけ残れば十分で、`memories.json` 固定でなくてよい、という前提で保存形式をどう定義しますか？**  
A: Markdown化

**Q (discover: Run Triggers): 利用者向けの Dream 実行契機はどうしますか？既存は session_start でタイマー開始、agent_end と timer、手動 `/dreaming run` です（extensions/pi-dreaming/index.ts:37-45、68-85、commands.ts:33-39）。**  
A: 自動＋手動

**Q (discover: Approval Model): Markdown メモリを残すとき、利用者の承認フローはどうしますか？既存は高信頼・非センシティブを自動保存し、候補は approve/reject します（README.md:48-50、commands.ts:84-101、store.ts:18-25）。**  
A: 常に自動保存

**Q (discover: Safety Boundary): 常に自動保存する前提で、保存してはいけない情報・安全策をどこまで必須にしますか？既存プロンプトは秘密情報の保存禁止とセンシティブ情報の扱いを明記しています（extensions/pi-dreaming/prompts.ts:4-8）。**  
A: 秘密情報は禁止

**Q (discover: Completion Signal): 受け入れ基準として、利用者が最低限どの動作を確認できれば成功にしますか？**  
A: 保存と再利用

**Q (discover: Markdown Organization Rule): Markdown メモリはどの整理規約まで Dream 処理に含めますか？**  
A: dreamingと同じ感じで

**Q (`extensions/pi-dreaming/dreamer.ts:226-272`, `extensions/pi-dreaming/dreamer.ts:230-261`): 現行は forbidden/sensitive/低信頼を active にしないだけで candidate としてディスク保存し得ます。Markdown では承認フローを外す前提なので、sensitive/低信頼メモリの扱いはどちらを正にしますか？**  
A: 通常のみ保存。secret/forbidden は破棄し、sensitive と低信頼も Markdown には保存しない。

**Q (`extensions/pi-dreaming/commands.ts:19-28`, `README.md:60-68`, `extensions/pi-dreaming/dreamer.ts:226-272`): candidate 分岐を実質なくす方向で、既存 `/dreaming approve` と `/dreaming reject` はどう扱うのが望ましいですか？**  
A: 完全削除。

## Related Research
- None.

## Open Questions
- None.
