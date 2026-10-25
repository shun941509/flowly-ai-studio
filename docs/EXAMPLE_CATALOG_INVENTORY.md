# AI Agent 예제와 소스 검증 집계 — 미완료

갱신: 2026-10-25T11:28:25.803Z

현재 소스는 **227개 그래프**(구조 227개·실행 설정 227개)입니다. 기본 공개 AI Agent 예제 **156개**와 별도 보조 흐름 **71개**로 구분합니다. AI Agent 예제 목표 3,200개까지 **3,044개가 남았습니다**. 보조 흐름은 이 목표 수에 더하지 않습니다. 기존 문구 중심 시나리오 3,200개를 독립 워크플로 완료로 집계한 주장은 철회합니다.

현재 소스·실행기 지문과 ZIP 해시까지 맞는 두 언어 검증은 소스 그래프 **227개**입니다. 이 중 AI Agent 예제 **156개**, 보조 흐름 **71개**이며, ZIP **454개**, 로컬 검사 **2414개**입니다. 현재 전체 소스 증거: **현재 소스 전체 일치**. 전체 소스 검증과 3,200개 목표 달성은 서로 다른 판정입니다. 검증 대기·실패·만료 항목은 이 수에 더하지 않습니다.

## 이전 집계의 범위

기존 3200개 시나리오를 비교하면 구조 6개·실행 설정 8개 그룹입니다. examples/workflow-identity-before.json에 전체 그룹과 ID를 보존합니다. 이전 catalog-verification.json, catalog-review.json, catalog-reviews/와 outputs/catalog/는 당시 문구 계약 검사 기록이며 현재 독립 워크플로 완료 증거로 사용하지 않습니다.

## 현재 설계

|설계|공개 분류|정상·경계 시나리오 수|현재 두 언어 검증|
|---|---|---:|---|
|completed-008-bounded-followup|AI Agent|3|통과|
|completed-009-applicable-policy|AI Agent|3|통과|
|completed-010-policy-change-impact|AI Agent|3|통과|
|completed-011-reviewed-index-intake|AI Agent|6|통과|
|completed-012-revocation-recheck|AI Agent|3|통과|
|completed-013-contracted-plan|AI Agent|2|통과|
|completed-014-paged-failed-only|AI Agent|4|통과|
|completed-015-same-criteria-candidates|AI Agent|2|통과|
|completed-016-issue-evidence-debate|AI Agent|2|통과|
|completed-018-edited-version-decision|AI Agent|3|통과|
|completed-020-runtime-budget-plan|AI Agent|4|통과|
|completed-021-typed-fallback|AI Agent|3|통과|
|completed-023-durable-agent-resume|AI Agent|2|통과|
|completed-024-correlated-response-trust|AI Agent|3|통과|
|completed-025-raw-table-unit-join|AI Agent|3|통과|
|completed-026-query-contract-calculation|AI Agent|2|통과|
|completed-027-deduplicated-followup|AI Agent|3|통과|
|completed-028-retained-notification-ledger|AI Agent|5|통과|
|completed-029-cross-service-reconcile|AI Agent|8|통과|
|completed-030-verified-project-memory|AI Agent|4|통과|
|completed-032-dependency-impact-replan|AI Agent|3|통과|
|completed-033-discriminating-hypotheses|AI Agent|3|통과|
|completed-034-counterexample-regression|AI Agent|3|통과|
|completed-035-constraint-repair|AI Agent|2|통과|
|completed-039-sensitivity-scenarios|AI Agent|2|통과|
|completed-043-capacity-counterproposal|AI Agent|2|통과|
|completed-045-document-review-invalidation|AI Agent|2|통과|
|completed-051-independent-ledger-audit|AI Agent|2|통과|
|completed-055-temporal-permission-rag|AI Agent|2|통과|
|completed-056-structured-document-join|AI Agent|2|통과|
|completed-057-permission-lineage-graph|AI Agent|2|통과|
|completed-058-cell-grounded-calculation|AI Agent|2|통과|
|completed-053-cross-store-revocation|AI Agent|2|통과|
|completed-060-api-consumer-contracts|AI Agent|2|통과|
|completed-061-migration-transformation-evidence|AI Agent|2|통과|
|completed-065-dependency-conflict-paths|AI Agent|2|통과|
|completed-066-technical-procedure-preflight|AI Agent|2|통과|
|completed-067-redacted-configuration-drift|AI Agent|2|통과|
|completed-068-code-api-document-alignment|AI Agent|2|통과|
|completed-036-first-sufficient-evidence|AI Agent|2|통과|
|completed-037-hierarchical-provenance-summary|AI Agent|2|통과|
|completed-038-semantic-document-image-check|AI Agent|2|통과|
|completed-040-persistent-event-correlation|AI Agent|2|통과|
|completed-041-two-stage-technical-tribunal|AI Agent|2|통과|
|completed-044-correlated-response-resume|AI Agent|7|통과|
|completed-047-diagnose-recover-verify|AI Agent|3|통과|
|completed-048-role-minimized-analysis|AI Agent|2|통과|
|completed-049-adaptive-registered-experiments|AI Agent|2|통과|
|completed-054-feedback-evaluate-publish|AI Agent|3|통과|
|completed-042-leased-taskboard-cas|AI Agent|4|통과|
|completed-050-goal-change-cancel-lineage|AI Agent|2|통과|
|completed-046-registered-development-team|AI Agent|2|통과|
|completed-062-stateful-learning-avatar|AI Agent|2|통과|
|completed-063-executed-code-practice-avatar|AI Agent|2|통과|
|completed-064-roleplay-state-and-rubric|AI Agent|2|통과|
|completed-069-reproduce-repair|AI Agent|4|통과|
|completed-070-behavior-refactor|AI Agent|4|통과|
|completed-071-offline-dependency-upgrade|AI Agent|4|통과|
|completed-072-mutation-test-gap|AI Agent|3|통과|
|completed-073-controlled-race-order|AI Agent|4|통과|
|completed-074-instrumented-performance|AI Agent|4|통과|
|completed-075-html-interaction-contract|AI Agent|4|통과|
|completed-076-reproducible-artifact|AI Agent|4|통과|
|completed-077-knowledge-lifecycle|AI Agent|4|통과|
|completed-078-evidence-impact-development|AI Agent|4|통과|
|completed-079-database-inventory|AI Agent|3|통과|
|completed-080-query-plan-comparison|AI Agent|4|통과|
|completed-081-index-plan-rollback|AI Agent|4|통과|
|completed-082-deadlock-target-release|AI Agent|4|통과|
|completed-083-schema-deploy-and-recover|AI Agent|5|통과|
|completed-084-full-backup-restoration|AI Agent|4|통과|
|completed-085-quality-correction-ledger|AI Agent|4|통과|
|completed-086-least-privilege-regression|AI Agent|4|통과|
|completed-087-archive-before-delete|AI Agent|4|통과|
|completed-088-replica-consistent-point|AI Agent|4|통과|
|completed-089-capacity-forecast-quality|AI Agent|4|통과|
|completed-090-relational-synthetic-data|AI Agent|4|통과|
|completed-091-integrated-db-manager|AI Agent|5|통과|
|completed-092-evidence-code-db|AI Agent|5|통과|
|completed-093-changed-goal-invalidation|AI Agent|4|통과|
|completed-096-step-dependency-repair|AI Agent|4|통과|
|completed-094-dynamic-integrated-company|AI Agent|5|통과|
|completed-100-persistent-claimed-board|AI Agent|6|통과|
|completed-095-all-blocks-release|AI Agent|4|통과|
|integrated-026-readonly-metrics|AI Agent|3|통과|
|integrated-049-adaptive-heldout-experiment|AI Agent|3|통과|
|integrated-027-transcript-followup|AI Agent|3|통과|
|integrated-069-code-repair|AI Agent|4|통과|
|integrated-070-behavior-refactor|AI Agent|4|통과|
|integrated-071-dependency-upgrade|AI Agent|4|통과|
|integrated-072-test-gap|AI Agent|2|통과|
|integrated-073-concurrency-analysis|AI Agent|2|통과|
|integrated-074-performance-regression|AI Agent|2|통과|
|integrated-075-frontend-verification|AI Agent|2|통과|
|integrated-076-reproducible-build|AI Agent|2|통과|
|integrated-079-database-diagnosis|AI Agent|2|통과|
|integrated-080-query-performance|AI Agent|2|통과|
|integrated-081-index-management|AI Agent|4|통과|
|integrated-082-deadlock-investigation|AI Agent|4|통과|
|integrated-083-schema-migration|AI Agent|5|통과|
|integrated-084-backup-restore|AI Agent|4|통과|
|integrated-086-database-permissions|AI Agent|4|통과|
|integrated-087-archive-retention|AI Agent|4|통과|
|integrated-088-replication-diagnosis|AI Agent|4|통과|
|integrated-089-capacity-planning|AI Agent|2|통과|
|integrated-090-test-data|AI Agent|4|통과|
|integrated-007-hybrid-tools|AI Agent|2|통과|
|integrated-057-graph-evidence|AI Agent|2|통과|
|integrated-085-data-quality-review|AI Agent|3|통과|
|integrated-043-cost-allocation|AI Agent|2|통과|
|integrated-039-signal-comparison|AI Agent|2|통과|
|integrated-048-redacted-agent-input|AI Agent|2|통과|
|integrated-100-adaptive-shared-board|AI Agent|2|통과|
|p3-rag-incremental|AI Agent|5|통과|
|p3-rag-local-revocation|AI Agent|5|통과|
|p3-rag-generation-recovery|AI Agent|6|통과|
|dynamic-subagent-task-team|AI Agent|9|통과|
|p4-tree-candidate-backtracking|AI Agent|5|통과|
|p4-graph-candidate-lineage|AI Agent|5|통과|
|p1-checkpoint-input-recovery|보조 흐름|2|통과|
|p2-hybrid-rank-fusion|AI Agent|3|통과|
|p2-structured-field-repair|AI Agent|4|통과|
|p2-independent-cove|AI Agent|5|통과|
|p4-approved-database-change|보조 흐름|4|통과|
|p4-goal-technical-team|보조 흐름|5|통과|
|policy-citations|보조 흐름|4|통과|
|typed-expense|보조 흐름|6|통과|
|log-redaction|보조 흐름|4|통과|
|schema-drift|보조 흐름|4|통과|
|invoice-reconcile|보조 흐름|5|통과|
|data-freshness|보조 흐름|4|통과|
|return-eligibility|보조 흐름|7|통과|
|accessibility-copy|보조 흐름|4|통과|
|incident-review|AI Agent|2|통과|
|procurement-crew|AI Agent|3|통과|
|release-readiness|AI Agent|3|통과|
|meeting-decisions|AI Agent|3|통과|
|research-conflicts|AI Agent|3|통과|
|curriculum-prerequisites|AI Agent|3|통과|
|contract-renewal|AI Agent|4|통과|
|knowledge-routing|보조 흐름|3|통과|
|inventory-tool-agent|AI Agent|3|통과|
|shipment-lookup|AI Agent|2|통과|
|ticket-intake|AI Agent|2|통과|
|handover-risks|AI Agent|2|통과|
|experiment-stop|보조 흐름|3|통과|
|warehouse-fefo|보조 흐름|2|통과|
|grant-evidence|AI Agent|3|통과|
|personal-task-dependencies|보조 흐름|2|통과|
|transport-retry-policy|보조 흐름|9|통과|
|conditional-cache-precedence|보조 흐름|7|통과|
|cursor-progress-checkpoint|보조 흐름|6|통과|
|canary-veto-review|보조 흐름|7|통과|
|fenced-checkpoint-resume|보조 흐름|6|통과|
|consumer-contract-change|보조 흐름|8|통과|
|circuit-breaker-probe|보조 흐름|6|통과|
|event-watermark-quarantine|보조 흐름|6|통과|
|biz-onboarding-blocker|보조 흐름|4|통과|
|biz-preorder-mixed-cart|보조 흐름|8|통과|
|biz-pickup-id-requirements|보조 흐름|5|통과|
|biz-personalization-preview|보조 흐름|7|통과|
|biz-gift-message-privacy|보조 흐름|3|통과|
|biz-comms-bcc-privacy|보조 흐름|5|통과|
|biz-product-save-dirty|보조 흐름|8|통과|
|biz-product-bulk-partial|보조 흐름|3|통과|
|biz-work-delegation-authority|보조 흐름|4|통과|
|biz-work-scope-baseline|보조 흐름|7|통과|
|biz-career-portfolio-confidential|보조 흐름|6|통과|
|biz-design-persona-evidence|보조 흐름|5|통과|
|biz-comms-request-vs-fyi|보조 흐름|6|통과|
|biz-product-filter-empty|보조 흐름|9|통과|
|biz-work-policy-exception-scope|보조 흐름|3|통과|
|biz-root-travel-through-stop|보조 흐름|5|통과|
|biz-room-capacity|보조 흐름|4|통과|
|biz-interest-recusal|보조 흐름|3|통과|
|biz-office-lostfound|보조 흐름|6|통과|
|biz-support-reopen|보조 흐름|6|통과|
|biz-support-next-question|보조 흐름|4|통과|
|biz-account-invite-expiry|보조 흐름|4|통과|
|biz-account-import-conflicts|보조 흐름|3|통과|
|biz-account-save-conflict|보조 흐름|4|통과|
|biz-account-comment-resolution|보조 흐름|7|통과|
|biz-event-remote-backup|보조 흐름|5|통과|
|biz-event-speaker-consent|보조 흐름|8|통과|
|biz-account-deletion-dependencies|보조 흐름|5|통과|
|biz-account-version-label|보조 흐름|3|통과|
|biz-a11y-menu-escape|보조 흐름|8|통과|
|biz-accessible-focus-return|보조 흐름|6|통과|
|biz-revision-game-action-replacement|보조 흐름|7|통과|
|rag-secondary-source|AI Agent|3|통과|
|rag-question-decomposition|AI Agent|5|통과|
|rag-conflict-review|AI Agent|3|통과|
|rag-citation-id-repair|AI Agent|4|통과|
|rag-query-normalization|AI Agent|3|통과|
|harness-prompt-regression|AI Agent|5|통과|
|harness-batch-schema-isolation|AI Agent|3|통과|
|agent-declared-confidence|AI Agent|5|통과|
|harness-blind-candidate-selection|AI Agent|6|통과|
|orchestrator-observe-then-decide|AI Agent|3|통과|
|orchestrator-reviewer-allocation|AI Agent|3|통과|
|team-critique-conditional-revision|AI Agent|3|통과|
|agent-specialist-handoff|AI Agent|5|통과|
|memory-approved-answer-revision|AI Agent|5|통과|
|memory-session-consent|AI Agent|5|통과|
|rag-two-hop-reference|AI Agent|4|통과|
|rel-linked-journal-gap|보조 흐름|5|통과|
|rel-migration-dry-run|보조 흐름|8|통과|
|rel-restore-evidence-priority|보조 흐름|7|통과|
|rel-cancel-completion-race|보조 흐름|8|통과|
|rel-manifest-publish-gate|보조 흐름|9|통과|
|rel-reference-row-quarantine|보조 흐름|6|통과|
|rel-measurement-unit-contract|보조 흐름|6|통과|
|rel-configuration-precedence|보조 흐름|9|통과|
|rel-credential-rotation-stages|보조 흐름|10|통과|
|rel-fragment-position-validation|보조 흐름|6|통과|
|rel-replica-read-version|보조 흐름|6|통과|
|rel-queue-capacity-exception|보조 흐름|11|통과|
|rel-backfill-range-contract|보조 흐름|7|통과|
|rel-alert-episode-lifecycle|보조 흐름|11|통과|
|rel-lineage-edge-evidence|보조 흐름|7|통과|
|rel-ambiguous-time-choice|보조 흐름|8|통과|
|showcase-parallel-proposal|AI Agent|7|통과|
|showcase-multi-agent-editorial|AI Agent|11|통과|
|showcase-rag-evidence|AI Agent|8|통과|
|showcase-request-orchestration|AI Agent|18|통과|
|showcase-agent-harness|AI Agent|17|통과|
|showcase-approved-publishing|AI Agent|10|통과|

## 검사 기준과 한계

- 원본: domain/workflow-designs/의 개별 정의. 제목·프롬프트·문서·모델명만 다른 변형은 독립 구현 수에서 제외합니다.
- 구조/설정: domain/workflow-identity.ts와 examples/catalog-audit.json. 서로 다른 서명만으로 유용성·의미 고유성이 증명되지는 않습니다.
- 실행: examples/workflow-verification.json. 실제 Node.js/Python ZIP의 CLI에서 분기·입출력·오류·상태 시나리오를 검사하며 모델·임베딩·MCP HTTP 응답을 ZIP 밖의 테스트 경계에서 주입합니다.
- 산출물: outputs/workflows/. 현재 설계·실행 해시, 실행기 지문, 시나리오 기록, 두 ZIP의 SHA-256을 대조합니다.
- 실제 OpenAI·원격 MCP 호출 0회. 실제 모델 정답률과 실계정 연결은 미검증입니다. 테스트 응답을 실제 AI 결과로 제공하지 않습니다.
- 새 그래프에 대한 독립 검토나 인간 검수 완료를 이 자동 집계가 인증하지 않습니다.

## 완료 판정

상태: **incomplete**. pnpm catalog:complete는 부분 집계를 기록하더라도 명시적 Agent를 포함한 3200개 서로 다른 구조·실행 설정 그룹과 현재 전체 소스의 두 언어 증거를 갖추지 못하면 종료 코드 1을 반환합니다.

- AI Agent 예제 156개(구조 156개·실행 설정 156개)/3200개 목표: 3044개가 남았습니다. 보조 흐름 71개는 목표 수에 더하지 않습니다.
