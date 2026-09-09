<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: verifier_misdiagnosis
investigation_contract:
  schema_version: 1
  not_applicable_reason: "Shared interpretation constraints apply to existing claims; this is not an independently classified investigation scene."
strategy_kind: contract_only
priority: 99
effort: low
keywords: []

verifier_misdiagnosis_patterns:
  - id: vsync_vrr_alignment_false_positive
    type: known_misdiagnosis
    scenes:
      - pipeline
      - touch_tracking
      - scrolling
      - scroll_response
      - interaction
    severity: warning
    patterns:
      - 'VSync.*(?:对齐异常|misalign|偏移)'
    message: 'VSync 对齐异常可能是正常的 VRR (可变刷新率) 行为，需确认设备是否支持 VRR'
  - id: buffer_stuffing_not_app_jank
    type: known_misdiagnosis
    scenes:
      - scrolling
      - pipeline
    severity: warning
    patterns:
      - 'Buffer Stuffing.*(?:严重|critical|掉帧)'
    message: 'Buffer Stuffing 是管线背压问题，非 App 逻辑缺陷 — 感知掉帧率已排除 Buffer Stuffing，请勿将其等同于真实掉帧'
  - id: single_frame_critical_false_positive
    type: known_misdiagnosis
    global: true
    severity: warning
    patterns:
      - '(?:单帧|single frame|1帧).*(?:异常|critical|严重)'
    message: '单帧异常不应标记为 CRITICAL — 需确认是否有模式性重复'
---

Verifier misdiagnosis guardrail contracts. This file is data-only and is not
injected into runtime prompts.
