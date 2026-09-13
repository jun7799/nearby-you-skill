#!/bin/bash
# test_api.sh — 服务端全链路验证(在服务器本机跑)
# 验证: 创建201 -> 同IP再建409 -> 错secret 401 -> 对secret修改200 -> nearby距离/脱敏 -> 删除200 -> IP释放再建201 -> 清理
# 用法: bash test_api.sh                    # 默认走本机 HTTP 3210
#       BASE=https://nearby.baihehuakai666.asia bash test_api.sh   # 走 HTTPS 443
# 注意: 两次运行间隔 >65s(服务端限流 30次/分/IP,连跑会撞 429 连锁)
set -u
BASE="${BASE:-http://localhost:3210}"
PASS=0; FAIL=0

jget() { echo "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d$2)" 2>/dev/null; }

check() { # check <描述> <期望> <实际>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "[PASS] $1"; else FAIL=$((FAIL+1)); echo "[FAIL] $1  期望=$2 实际=$3"; fi
}

echo "== 0. health =="
H=$(curl -s $BASE/api/health)
check "health ok" "True" "$(jget "$H" "['ok']")"

echo "== 1. 创建资料(期望201) =="
R1=$(curl -s -w '\n%{http_code}' -X POST $BASE/api/profile -H 'Content-Type: application/json' -d \
  '{"nickname":"测试用户甲","bio":"全链路测试用","agent_info":"Claude Code v2 / Win11","contact":"test@example.com","location":{"lat":23.174,"lon":114.309,"source":"gps"}}')
CODE1=$(echo "$R1" | tail -1); BODY1=$(echo "$R1" | head -n -1)
check "创建返回201" "201" "$CODE1"
ID=$(jget "$BODY1" "['id']")
SECRET=$(jget "$BODY1" "['secret']")
check "返回id" "True" "$([ -n "$ID" ] && echo True)"
check "返回secret" "True" "$([ -n "$SECRET" ] && echo True)"

echo "== 2. 同IP再建(期望409 IP_TAKEN) =="
R2=$(curl -s -w '\n%{http_code}' -X POST $BASE/api/profile -H 'Content-Type: application/json' -d \
  '{"nickname":"测试用户乙","location":{"lat":23.17,"lon":114.31,"source":"gps"}}')
CODE2=$(echo "$R2" | tail -1)
check "同IP再建409" "409" "$CODE2"

echo "== 3. 错secret修改(期望401) =="
CODE3=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $BASE/api/profile/$ID -H 'X-Auth-Secret: wrong-secret' -H 'Content-Type: application/json' -d '{"nickname":"改名"}')
check "错secret 401" "401" "$CODE3"

echo "== 4. 对secret修改(期望200+新昵称) =="
R4=$(curl -s -w '\n%{http_code}' -X PUT $BASE/api/profile/$ID -H "X-Auth-Secret: $SECRET" -H 'Content-Type: application/json' -d '{"nickname":"测试用户甲改"}')
CODE4=$(echo "$R4" | tail -1); BODY4=$(echo "$R4" | head -n -1)
check "对secret 200" "200" "$CODE4"
check "昵称已更新" "测试用户甲改" "$(jget "$BODY4" "['profile']['nickname']")"

echo "== 5. nearby: 上海查询(验证测试条目距离) + 字段脱敏 =="
R5=$(curl -s "$BASE/api/nearby?lat=31.23&lon=121.47&radius_km=5000&limit=50")
# 不假设库为空:在结果里找本次测试创建的那条(惠州坐标,距上海应 >1000km)
IDX=$(echo "$R5" | python3 -c "import sys,json;d=json.load(sys.stdin);print([i for i,r in enumerate(d['results']) if r['id']=='$ID'][0] if any(r['id']=='$ID' for r in d['results']) else -1)")
check "nearby能查到测试条目" "True" "$([ "$IDX" -ge 0 ] && echo True)"
if [ "$IDX" -ge 0 ]; then
  DIST=$(jget "$R5" "['results'][$IDX]['distance_km']")
  check "测试条目距上海>1000km" "True" "$(python3 -c "print($DIST > 1000)")"
fi
check "响应不含secret_hash" "False" "$(echo "$R5" | grep -q secret_hash && echo True || echo False)"
check "响应不含source_ip" "False" "$(echo "$R5" | grep -q source_ip && echo True || echo False)"

echo "== 6. geocode: 高德逆地理(期望source=amap;无key时应为none) =="
R6=$(curl -s "$BASE/api/geocode?lat=23.17&lon=114.31")
check "geocode可用" "True" "$(python3 -c "import json,sys;s=json.loads('''$R6''').get('source','');print(s in ('amap','none'))")"

echo "== 7. ip-location =="
if [[ "$BASE" == *localhost* || "$BASE" == *127.0.0.1* ]]; then
  # localhost 场景:源IP是127.0.0.1(内网),应502
  CODE7=$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/ip-location)
  check "内网IP定位502(localhost场景)" "502" "$CODE7"
else
  # 域名场景:源IP是服务器公网IP,应能定位出坐标
  R7=$(curl -s $BASE/api/ip-location)
  LAT7=$(jget "$R7" "['lat']")
  check "公网IP定位有坐标(域名场景)" "True" "$([ -n "$LAT7" ] && [ "$LAT7" != "None" ] && echo True)"
fi

echo "== 8. 删除(期望200) =="
CODE8=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $BASE/api/profile/$ID -H "X-Auth-Secret: $SECRET")
check "删除200" "200" "$CODE8"

echo "== 9. 删除后同IP再建(期望201, IP名额已释放) =="
R9=$(curl -s -w '\n%{http_code}' -X POST $BASE/api/profile -H 'Content-Type: application/json' -d \
  '{"nickname":"释放后重建","location":{"lat":23.17,"lon":114.31,"source":"gps"}}')
CODE9=$(echo "$R9" | tail -1); BODY9=$(echo "$R9" | head -n -1)
check "IP释放后可再建" "201" "$CODE9"

echo "== 10. 清理测试数据 =="
ID9=$(jget "$BODY9" "['id']"); SEC9=$(jget "$BODY9" "['secret']")
CODE10=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $BASE/api/profile/$ID9 -H "X-Auth-Secret: $SEC9")
check "清理成功" "200" "$CODE10"
# 不假设库为空:重复 DELETE 同一 id 应 404(资料不存在),证明真的删干净了
CODE11=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $BASE/api/profile/$ID9 -H "X-Auth-Secret: $SEC9")
check "测试资料已删净(重复DELETE应404)" "404" "$CODE11"

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ $FAIL -eq 0 ] || exit 1
