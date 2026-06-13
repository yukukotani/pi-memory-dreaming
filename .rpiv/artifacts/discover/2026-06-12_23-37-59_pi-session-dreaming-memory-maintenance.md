---
date: 2026-06-12T23:37:59+0900
author: Yuku Kotani
commit: b746064
branch: main
repository: pi-memory-dreaming
topic: "pi-session-dreaming-memory-maintenance"
tags: [intent, frd, pi-dreaming, memory, markdown]
status: ready
last_updated: 2026-06-12T23:37:59+0900
last_updated_by: Yuku Kotani
---

# FRD: pi-session-dreaming-memory-maintenance

## Summary
`pi-memory-dreaming` を、Claude Managed Agents の Dream 機能に近い「pi session に対する記憶保守」へ寄せる。既存の pi extension と `/dreaming` 入口は維持しつつ、内部処理は session から durable memory を抽出するだけでなく、Markdown メモリを検証・追記・整理し、次回以降の agent turn で再利用できるようにする。

## Problem & Intent
開発者の意図は利用者向けの Dream 体験を作ること。

> ant sessionを使いたいわけじゃない。pi sessionに対して同じようなdreaming処理をしたいということ

> メモリだけ残っていれば十分。でも memories.json という形式じゃなくてもいい

Markdown メモリの整理規約は「dreamingと同じ感じで」とし、Claude Managed Agents Dream の例にあるような memory maintenance（検証、追記、整理、リンク、索引、統合）を pi session に適用する。

## Goals
- pi session の内容から、将来の会話に役立つ durable memory を自動的に残す。
- 既存の `/dreaming` command と lifecycle による利用者体験を維持し、通常利用では明示操作なしに記憶が保守される。
- メモリは JSON 固定ではなく、人間が読めて整理しやすい Markdown として保存する。
- Dream 風に、既存メモリの検証、矛盾時の修正、情報の追加、関連リンク、索引更新、必要に応じた統合・リネームを行う。
- 保存された Markdown メモリが次回以降の agent turn で recall される。

## Non-Goals
- Anthropic Managed Agents の `ant beta:sessions retrieve` や外部 session zip を入力することは対象外。入力は pi session。
- standalone CLI または HTTP/API server の追加は対象外。入口は既存の pi extension / `/dreaming`。
- Dream 実行ごとの詳細 artifact、HTML report、run log を永続化することは必須ではない。残すべき成果物はメモリ。
- `memories.json` 形式の維持は必須ではない。
- 利用者承認による candidate/approve/reject フローは必須ではない。常時自動保存を前提にする。

## Functional Requirements
1. The system SHALL keep the existing pi extension entrypoint and `/dreaming` command surface as the user-facing entry.
2. The system SHALL run Dream processing against the current pi session transcript/branch, not against Anthropic `ant` sessions or external session archives.
3. The system SHALL support both automatic execution and manual execution via `/dreaming run` / `/dreaming run --force`.
4. The system SHALL transform the current single-pass memory synthesis into a memory maintenance workflow that can verify existing Markdown memories against the pi session, enrich them with new durable information, and remove or revise contradicted stale claims.
5. The system SHALL persist memories as Markdown files under a project-local dreaming memory directory, rather than requiring `.pi/dreaming/memories.json` as the canonical storage format.
6. The system SHALL organize Markdown memories in a Dream-like style: frontmatter with stable slug/name and description, body text with durable facts, `[[slug]]` links for related topics, and a root index listing memory files.
7. The system SHALL consolidate, rename, or group Markdown memories when doing so improves discovery without losing facts.
8. The system SHALL auto-save accepted memory changes without requiring an approve/reject step.
9. The system SHALL recall active Markdown memories before future agent turns and append them to the agent context in the same role currently handled by `before_agent_start`.
10. The system SHALL avoid saving secrets, credentials, API keys, passwords, tokens, private keys, one-time codes, or sensitive personal information unless the user explicitly requested remembering it.

## Non-Functional Requirements
- **Performance**: No specific latency target. Automatic Dream processing should avoid blocking normal user interaction and may continue to skip unchanged or too-small sessions.
- **Security**: Secrets and credentials must never be saved to Markdown memory. Sensitive information should default to not saved unless explicitly requested by the user.
- **UX / Accessibility**: Existing `/dreaming` command affordances should remain understandable; normal users should not need to run `/dreaming` during routine use.
- **Reliability**: Markdown memory writes should be durable and recoverable. Multi-file updates should avoid partial corruption where practical, and failed Dream runs should not erase existing memories.

## Constraints & Assumptions
- The implementation stays within the current Bun/TypeScript pi extension package.
- Existing package registration already exposes `./extensions/pi-dreaming/index.ts` as the pi extension.
- Existing session access comes from `ctx.sessionManager.getBranch()` and `ctx.sessionManager.getSessionFile()`; research should verify the exact transcript fidelity available from pi.
- Existing storage is `.pi/dreaming/memories.json`; the new design may migrate to or layer over `.pi/dreaming/memories/` Markdown files.
- Existing auto-save candidate confidence semantics may be removed or adapted because the chosen behavior is always auto-save.

## Acceptance Criteria
- [ ] Running `bun run check` exits 0 after the implementation.
- [ ] In a local pi run with this extension enabled, running `/dreaming run --force` after a session containing a durable preference creates or updates Markdown files under `.pi/dreaming/memories/`.
- [ ] Running `test -f .pi/dreaming/memories/_index.md` exits 0 after a successful Dream run, and `_index.md` lists the created/updated memory slug.
- [ ] Running `rg '^---|^name:|^description:' .pi/dreaming/memories` shows each memory file has frontmatter with `name` and `description`.
- [ ] After a memory is saved, a subsequent pi agent turn receives the saved memory through the recall path; a prompt that asks about the remembered preference is answered using the Markdown memory.
- [ ] A session containing an API key/token-like string does not save that secret; running `rg 'api[_-]?key|token|sk-' .pi/dreaming/memories` does not reveal the secret value.
- [ ] Running `/dreaming status` still reports the dreaming system state without requiring the user to inspect raw files.

## Recommended Approach
Keep the existing pi extension and `/dreaming` lifecycle seam, but replace the canonical JSON-store synthesis path with a Markdown-backed Dream maintenance workflow over the current pi session. The workflow should read session digest plus existing Markdown memories, produce safe auto-saved memory edits, maintain an index/link structure, and feed those Markdown memories back through the existing recall hook.

## Decisions

### Foundational Intent
**Question**: Claude Managed Agents の Dream と同等の仕組みを、このリポジトリで実現したい背景として、いま誰がどんな問題に当たっていて、成功するとその人に何が起きますか？  
**Recommended**: n/a — `intent` question  
**Chosen**: 利用者向け  
**Rationale**: 利用者が pi session に対する Dream 処理の恩恵を受ける体験を中心にする。

### User-Facing Entry
**Question**: プローブから、既存の利用者向け入口は pi 拡張の `/dreaming` コマンドと lifecycle で、standalone CLI/API はありません（package.json:24-31、extensions/pi-dreaming/commands.ts:8-28）。この前提を維持しますか？  
**Recommended**: 維持する  
**Chosen**: 維持する  
**Rationale**: evidence: package.json:24-31 + extensions/pi-dreaming/commands.ts:8-28 + confirmed; scope is pi extension UX, not a new CLI/API surface.

### Session Input Source
**Question**: プローブから、既存実装は現在の pi セッション branch を digest 化しており、`ant beta:sessions retrieve` のような外部セッション取得/zip入力はありません（extensions/pi-dreaming/session.ts:26-31、55-67）。Dream 互換としてどちらを要件にしますか？  
**Recommended**: 外部セッション対応  
**Chosen**: ant sessionを使いたいわけじゃない。pi sessionに対して同じようなdreaming処理をしたいということ  
**Rationale**: Developer correction narrows compatibility to the mechanism and user outcome, not Anthropic session input compatibility.

### Output Artifact Scope
**Question**: プローブから、成果物は `.pi/dreaming/memories.json` に集約され、run ごとの artifact/log/report はありません（README.md:52-53、extensions/pi-dreaming/store.ts:16、57-83）。確認体験はどうしますか？  
**Recommended**: run成果物を追加  
**Chosen**: メモリだけ残っていれば十分。でも memories.json という形式じゃなくてもいい  
**Rationale**: The user values persistent memory over per-run reports and explicitly allows changing the storage format.

### Goal Depth
**Question**: この FRD の主ゴールは、pi session に対してどの粒度で Managed Agents Dream 風の処理を再現することにしますか？  
**Recommended**: 記憶保守まで  
**Chosen**: 記憶保守まで  
**Rationale**: Matches the requested Dream-like mechanism: not just summarization, but durable memory maintenance for future use.

### Processing Shape
**Question**: 既存は 1 回の `complete()` で JSON のメモリ更新案を作る形です（extensions/pi-dreaming/dreamer.ts:123-174、extensions/pi-dreaming/prompts.ts:26-50）。Managed Agents Dream 風に寄せる処理形状はどれにしますか？  
**Recommended**: 保守ワークフロー化  
**Chosen**: 保守ワークフロー化  
**Rationale**: Optimizes Dream-like verification/enrichment/organization while preserving the existing `/dreaming` entry.

### Memory Storage Format
**Question**: メモリだけ残れば十分で、`memories.json` 固定でなくてよい、という前提で保存形式をどう定義しますか？  
**Recommended**: 形式は抽象化  
**Chosen**: Markdown化  
**Rationale**: Markdown better supports human-readable Dream-style organization, links, frontmatter, and index maintenance.

### Run Triggers
**Question**: 利用者向けの Dream 実行契機はどうしますか？既存は session_start でタイマー開始、agent_end と timer、手動 `/dreaming run` です（extensions/pi-dreaming/index.ts:37-45、68-85、commands.ts:33-39）。  
**Recommended**: 自動＋手動  
**Chosen**: 自動＋手動  
**Rationale**: Keeps the existing low-friction UX while allowing explicit forced runs for verification.

### Approval Model
**Question**: Markdown メモリを残すとき、利用者の承認フローはどうしますか？既存は高信頼・非センシティブを自動保存し、候補は approve/reject します（README.md:48-50、commands.ts:84-101、store.ts:18-25）。  
**Recommended**: 安全側の候補制  
**Chosen**: 常に自動保存  
**Rationale**: User prefers Dream-like autonomous maintenance over a candidate review workflow; safety must be enforced by filtering and correction behavior.

### Safety Boundary
**Question**: 常に自動保存する前提で、保存してはいけない情報・安全策をどこまで必須にしますか？既存プロンプトは秘密情報の保存禁止とセンシティブ情報の扱いを明記しています（extensions/pi-dreaming/prompts.ts:4-8）。  
**Recommended**: 秘密情報は禁止  
**Chosen**: 秘密情報は禁止  
**Rationale**: Always-auto-save requires a hard exclusion for credentials and sensitive data to avoid durable leakage.

### Completion Signal
**Question**: 受け入れ基準として、利用者が最低限どの動作を確認できれば成功にしますか？  
**Recommended**: 保存と再利用  
**Chosen**: 保存と再利用  
**Rationale**: The feature is only useful if the saved memory is both persisted and recalled in later agent turns.

### Markdown Organization Rule
**Question**: Markdown メモリはどの整理規約まで Dream 処理に含めますか？  
**Recommended**: frontmatter＋index  
**Chosen**: dreamingと同じ感じで  
**Rationale**: Interpreted as Dream-style organization: frontmatter, index, links, consolidation, renames, and pruning low-value content.

## Open Questions
- None.

## References
- User-provided example command: `ant beta:sessions retrieve --session-id sesn_01Fo3jLcCMG8YS3WRAGTxSko`
- Claude Managed Agents Dreams documentation: https://platform.claude.com/docs/en/managed-agents/dreams
- `README.md:40-68`
- `package.json:24-31`
- `extensions/pi-dreaming/index.ts:37-45`, `extensions/pi-dreaming/index.ts:68-85`
- `extensions/pi-dreaming/commands.ts:8-39`, `extensions/pi-dreaming/commands.ts:84-101`
- `extensions/pi-dreaming/session.ts:26-31`, `extensions/pi-dreaming/session.ts:55-67`
- `extensions/pi-dreaming/store.ts:16-25`, `extensions/pi-dreaming/store.ts:57-83`
- `extensions/pi-dreaming/dreamer.ts:123-174`
- `extensions/pi-dreaming/prompts.ts:4-8`, `extensions/pi-dreaming/prompts.ts:26-50`
