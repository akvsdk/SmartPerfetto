<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2024-2026 Gracker (Chris)
This file is part of SmartPerfetto. See LICENSE for details.
-->
---
scene: smart
investigation_contract:
  schema_version: 1
  not_applicable_reason: "Aggregate bound child-scene investigation states; this contract does not define a new trace investigation."
strategy_kind: contract_only
priority: 5
effort: high
keywords:
  - smart
  - 智能
  - mixed trace
  - 场景混合
required_capabilities: []
optional_capabilities: []
final_report_contract:
  required_sections:
    - id: scene_timeline
      label: 场景时间线
      description: 按时间顺序列出 trace 中检测到的关键用户操作和设备状态场景。
      pattern_groups:
        - ["场景时间线", "timeline", "时间线"]
        - ["冷启动", "热启动", "滑动", "点击", "返回", "Home", "亮屏", "熄屏", "ANR"]
    - id: per_scene_summary
      label: 分场景摘要
      description: 对每个被深度分析的场景给出关键指标、结论和证据引用。
      pattern_groups:
        - ["分场景", "逐场景", "per-scene"]
        - ["证据", "指标", "耗时", "延迟", "帧"]
    - id: cross_scene_narrative
      label: 跨场景叙事
      description: 总结多个场景之间的关联、共同瓶颈或前后影响。
      pattern_groups:
        - ["跨场景", "整体", "关联", "链路"]
        - ["原因", "影响", "共同", "瓶颈"]
    - id: bottleneck_ranking
      label: 瓶颈排序
      description: 按影响范围、严重度和可行动性给出优化优先级。
      pattern_groups:
        - ["瓶颈排序", "优先级", "ranking"]
        - ["P0", "P1", "优先", "建议"]
---

# Smart Analysis Contract

This strategy is intentionally contract-only. It must not be injected as a
normal scene strategy and must not participate in scene classification.

Smart Analysis Mode combines Scene Story detection with profile-specific
deep-dive routes, then projects the resulting scene report into a readable chat
summary and the standard HTML report chain.
