#!/usr/bin/env bash
# 发布闸门（Release gate）——**把"自造的对抗者"变成默认动作，而不是等人开口**。
#
# 背景（2026-09-16 的实测）：
#   · 内省 + 三轮自审，在 0.8.1 上找到的**实质**缺陷是 0；
#   · 一个 fresh-context 红队，在同版本上找出 **6 个**（其中 2 个推翻了我刚声称"已验证"的断言）；
#   · 变异测试发现 8 个守卫里 **4 个是装饰品**。
# 这三件事都不是"更小心"能做到的，所以必须由闸门强制。
#
# 用法：bash scripts/release-check.sh [版本号]（缺省取 plugin/package.json 的 version）
set -uo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(python3 -c "import json;print(json.load(open('plugin/package.json'))['version'])")}"
PKG_VERSION="$(python3 -c "import json;print(json.load(open('plugin/package.json'))['version'])")"
PASS=0; FAIL=0; GAPS=0
note() { printf '  %s %s\n' "$1" "$2"; }
ok()   { PASS=$((PASS+1)); note '✓' "$1"; }
bad()  { FAIL=$((FAIL+1)); note '✗' "$1"; }
gap()  { GAPS=$((GAPS+1)); note '⊘' "$1"; }

echo "发布闸门 —— 版本 ${VERSION}"
echo
# 防止"用参数绕过"：显式传入的版本必须与 package.json 一致（否则闸门检查的是一个不存在的版本）
if [ "$VERSION" != "$PKG_VERSION" ]; then
  echo "  ✗ 参数版本 ${VERSION} 与 plugin/package.json 的 ${PKG_VERSION} 不一致 —— 闸门不允许检查别的版本"
  exit 1
fi

echo "== 1. 环境泛化审计（scripts/audit.sh）=="
if bash scripts/audit.sh >/tmp/release-audit.log 2>&1; then
  ok "审计通过（$(grep -c '✓' /tmp/release-audit.log) 项；已知缺口 $(grep -c '⊘' /tmp/release-audit.log) 项如实记录）"
else
  bad "审计未通过 —— 见 /tmp/release-audit.log"; awk 'NR>0{printf "      %s\n", $0}' "$(tail -12 /tmp/release-audit.log > /tmp/rel-tail.txt; echo /tmp/rel-tail.txt)" 
fi

echo "== 2. 变异测试：守卫必须真的在守（scripts/mutation-test.mjs）=="
if node scripts/mutation-test.mjs >/tmp/release-mutation.log 2>&1; then
  # 红队 F8：必须**核对数量**，不能只看退出码（此前 grep -o '杀死 [0-9]*' 为空也照样打勾）
  KILLED=$(grep -oE '杀死 [0-9]+' /tmp/release-mutation.log | head -1 | grep -oE '[0-9]+' || echo 0)
  EQUIV=$(grep -oE '等价（已记录）[0-9]+' /tmp/release-mutation.log | grep -oE '[0-9]+' || echo 0)
  if [ "${KILLED:-0}" -ge 6 ] && [ "${EQUIV:-0}" -le 1 ]; then
    ok "变异测试：杀死 ${KILLED} 个，等价 ${EQUIV} 个（≤ 预算 1），无存活"
  else
    bad "变异测试数量异常：杀死 ${KILLED:-?}、等价 ${EQUIV:-?}（期望 杀死≥6 且 等价≤1）"
  fi
else
  bad "存在存活的变异（= 那些守卫是装饰品）"; grep -A6 '存活的变异' /tmp/release-mutation.log | sed 's/^/      /'
fi

echo "== 3. 全套测试（五套：fixtures / catalog / observer / conformance / 语料 / 论坛病例）=="
if node --test plugin/test/*.mjs >/tmp/release-tests.log 2>&1; then
  ok "全套通过（$(grep -cE '^✔' /tmp/release-tests.log) 项）"
else
  bad "测试未通过"; grep -E '^✖' /tmp/release-tests.log | head -6 | sed 's/^/      /'
fi

echo "== 4. 红队档案（本版本必须留下，否则不许发布）=="
RT="docs/redteam-${VERSION}.md"
if [ -f "$RT" ]; then
  # 只检查"文件存在"太弱（空文件也能过）——必须**非平凡**且包含反例章节，否则形同虚设
  SIZE=$(wc -c < "$RT" | tr -d ' ')
  if [ "$SIZE" -lt 500 ]; then
    bad "红队档案 ${RT} 只有 ${SIZE} 字节 —— 太短，必须包含真反例/已覆盖/未能验证三节"
  elif ! grep -qE '真反例|反例' "$RT"; then
    bad "红队档案 ${RT} 缺少反例章节"
  else
    ok "红队档案存在且非平凡（${SIZE} 字节）：${RT}"
  fi
else
  bad "缺少红队档案 ${RT} —— 请先按 docs/redteam-brief.md 起一个 fresh-context 证伪者，把反例清单落盘"
fi

echo "== 5. 未决项的可见性 =="
if grep -q '§5 待决策' docs/check-authoring-rules.md 2>/dev/null; then
  gap "§5 仍有待决策/已知缺口（$(grep -cE '^\| \*\*D[0-9]+\*\*' docs/check-authoring-rules.md) 条）——已记录即可，不许沉默"
else
  bad "docs/check-authoring-rules.md 缺少 §5 待决策清单"
fi

echo
echo "闸门结果：通过 ${PASS} 项，失败 ${FAIL} 项，已知缺口 ${GAPS} 项"
if [ "$FAIL" -gt 0 ]; then
  echo "→ **不许发布**：先修失败项。"
  exit 1
fi
echo "→ 可以发布（已知缺口已在 §5 / defect-ledger 中公开记录）。"
