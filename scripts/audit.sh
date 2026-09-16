#!/usr/bin/env bash
# 可重审的环境泛化审计（R12 可重审律 + R13 环境泛化律）。
#
# 目的：把"这次我想起来查这几处"变成**一条命令、固定步骤、每次可比**。
# 每一项都在一个**不同环境**下运行工具，并断言该环境下的判定不会说过头的话。
set -uo pipefail
cd "$(dirname "$0")/.."
CLI=plugin/dsh-doctor.mjs
PASS=0; FAIL=0
chk() { # chk <名称> <条件成立则 0>
  if [ "$2" -eq 0 ]; then printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); else printf '  ✗ %s\n' "$1"; FAIL=$((FAIL+1)); fi
}
tmp() { mktemp -d; }
emptyp() { mkdir -p "$1/profiles/web"; printf '{"name":"web","version":"0.0.0","dsh":{"profile":{"bundles":[]}}}' > "$1/profiles/web/package.json"; }

echo "== 审计 1：空环境 —— 零对象不得等于通过 =="
H=$(tmp); emptyp "$H"
out=$(DSH_HOME=$H node $CLI --boot-check --profile web 2>&1)
echo "$out" | grep -q "✓ 所有可探测 entry" && chk "boot-check 零对象未谎报通过" 1 || chk "boot-check 零对象未谎报通过" 0
# 不变量的端到端形式：ok === true 必须蕴含 verified > 0（而不是假设某环境下 verified 恰好为 0
# ——我第一版就是这么假设的，那个断言本身就是"断言强度超过证据"，见 R8）
out2=$(DSH_HOME=$H node $CLI --json --no-catalog --profile web 2>/dev/null)
python3 - "$out2" <<'PY' && chk "JSON: ok=true 蕴含 verified>0" 0 || chk "JSON: ok=true 蕴含 verified>0" 1
import json,sys
i=sys.argv[1].find('{'); d=json.loads(sys.argv[1][i:])
sys.exit(0 if (not d.get("ok")) or (d.get("verified",0) > 0) else 1)
PY
rm -rf "$H"

echo "== 审计 2：极简 PATH（无 dsh/pnpm/zstd）—— 全跳过时不得说全部通过 =="
H=$(tmp); emptyp "$H"; ND=$(dirname "$(command -v node)")
out=$(DSH_HOME=$H PATH="$ND" node $CLI --no-catalog --profile web 2>&1)
echo "$out" | grep -q "全部通过" && chk "全跳过时未说「全部通过」" 1 || chk "全跳过时未说「全部通过」" 0
rm -rf "$H"

echo "== 审计 3：畸形输入 —— 早期失败不得掩盖其余检查 =="
H=$(tmp); mkdir -p "$H/profiles/web"; printf '\xEF\xBB\xBF{"name":"web","version":"0.0.0","dsh":{"profile":{"bundles":[]}}}' > "$H/profiles/web/package.json"
out=$(DSH_HOME=$H node $CLI --json --no-catalog --profile web 2>/dev/null)
echo "$out" | grep -q '"P15"' && chk "带 BOM 时 P15 仍报出（故障隔离）" 0 || chk "带 BOM 时 P15 仍报出" 1
printf '{ "name": "web", "dsh": { "profile": { "bundles": [ }' > "$H/profiles/web/package.json"
n=$(DSH_HOME=$H node $CLI --json --no-catalog --profile web 2>/dev/null | grep -o '"id"' | wc -l | tr -d ' ')
[ "$n" -gt 1 ] && chk "manifest 无法解析时其余检查仍运行（$n 项）" 0 || chk "manifest 无法解析时其余检查仍运行" 1
rm -rf "$H"

echo "== 审计 4：清单与闭集 =="
node scripts/gen-check-inventory.mjs | diff -q - docs/check-inventory.md >/dev/null && chk "检查清单与代码一致" 0 || chk "检查清单与代码一致" 1
node --test plugin/test/fixtures.mjs >/dev/null 2>&1 && chk "全套测试（含闭集断言）通过" 0 || chk "全套测试通过" 1

echo
echo "审计结果：通过 $PASS 项，失败 $FAIL 项"
[ "$FAIL" -eq 0 ] || exit 1
