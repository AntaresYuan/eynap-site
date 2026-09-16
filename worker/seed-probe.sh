#!/usr/bin/env bash
# 把探针样本直接写进 D1，绕过反垃圾限流。
# 限流是给真实用户的保护，不该为了自测放宽阈值。
set -euo pipefail
cd "$(dirname "$0")"

run() { npx wrangler d1 execute eynap --remote --command "$1" >/dev/null 2>&1; }

# 先清掉上一轮的探针数据
run "DELETE FROM reviews WHERE author='probe'"

add() {
  local t="${1//\'/\'\'}"
  run "INSERT INTO reviews (author,text,feature,effect,stability,version,ip_hash)
       VALUES ('probe','$t',4,4,4,'2.0.0','probe')"
}

add 'The skill split is clean. I can call pm-prd alone without running the whole pipeline.'
add '拆分很清楚。单点需求不用跑全流程；上手也快。'
add 'Read SKILL.md first. It explains how pm-entity and pm-design fit together.'
add 'One sentence only'
add 'Works on v2.0.0 fine. No issues so far.'
add '我用 pm-research 做了竞品调研，结论直接喂给 pm-value，省了一轮返工。'
add 'Great! Really useful. Would recommend.'
add 'The orchestrator decides the stage. Then it routes to one skill.'

echo "探针样本已写入"
