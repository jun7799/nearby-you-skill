#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nearby.py — 「附近的你」skill 核心脚本
API 客户端 + 本地身份管理。服务端文档见 server/README.md。

用法:
    python nearby.py health                          # 检查服务连通性
    python nearby.py ip-loc                          # 服务端按来源 IP 定位
    python nearby.py geocode --lat 31.2 --lon 121.4  # 经纬度 -> 中文地址
    python nearby.py geocode --city 上海             # 城市名 -> 经纬度
    python nearby.py create --file body.json         # 创建资料(JSON 文件,UTF-8)
    python nearby.py update --file body.json         # 修改资料(自动带鉴权)
    python nearby.py delete --yes                    # 删除我的资料(自动带鉴权)
    python nearby.py nearby                          # 查附近(缺省用缓存位置)
    python nearby.py nearby --lat 31.2 --lon 121.4 --radius 50 --limit 10
    python nearby.py whoami                          # 查看本地身份(secret 打码)

注意: create/update 的 JSON 用 --file 文件传,不要用 PowerShell 管道传中文
      (PS 5.1 管道默认 ASCII 编码,中文会变问号)。

输出契约: 进度信息走 [INFO]/[OK]/[WARN]/[ERROR] 行; 最终结果固定在最后一行
         RESULT_JSON: {...}  —— 上层(Claude)只解析该行。
"""

import sys, io, os, json, argparse, urllib.request, urllib.error, urllib.parse, tempfile

# Windows UTF-8 输入输出(硬性惯例;中文 JSON 链路必须)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
if hasattr(sys.stdin, 'reconfigure'):
    sys.stdin.reconfigure(encoding='utf-8')

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, '..', 'config.yaml')

# 默认身份文件路径,可被 config.yaml 覆盖
DEFAULT_IDENTITY_PATH = os.path.join(os.path.expanduser('~'), '.nearby-you', 'identity.json')


# ---------- 配置 ----------

def load_config():
    """读 config.yaml。PyYAML 缺失时用内置简易解析器兜底(本配置结构固定)。"""
    cfg = {'api': {'base': 'http://124.221.77.217:3210', 'timeout': 10},
           'default': {'radius_km': 50, 'limit': 10},
           'identity_file': DEFAULT_IDENTITY_PATH}
    if not os.path.exists(CONFIG_PATH):
        return cfg
    try:
        text = open(CONFIG_PATH, encoding='utf-8').read()
        try:
            import yaml  # 有就用,更稳
            data = yaml.safe_load(text) or {}
        except ImportError:
            data = _mini_yaml(text)
        for section in ('api', 'default'):
            if isinstance(data.get(section), dict):
                cfg[section].update({k: v for k, v in data[section].items() if k in cfg[section]})
        if data.get('identity_file'):
            cfg['identity_file'] = data['identity_file']
    except Exception as e:
        print(f'[WARN] 读取配置失败,使用内置默认值: {e}')
    return cfg


def _mini_yaml(text):
    """两级 key: value 结构的极简解析器(仅覆盖本 config.yaml 的形状)。"""
    data, section = {}, None
    for line in text.splitlines():
        line = line.split('#', 1)[0].rstrip()
        if not line.strip():
            continue
        if not line.startswith(' ') and line.endswith(':'):
            section = line[:-1].strip()
            data[section] = {}
        elif ':' in line and section:
            k, _, v = line.strip().partition(':')
            v = v.strip().strip('"').strip("'")
            try:
                v = int(v)
            except ValueError:
                pass
            data[section][k.strip()] = v
        elif ':' in line and not section:
            k, _, v = line.partition(':')
            data[k.strip()] = v.strip().strip('"').strip("'")
    return data


CONFIG = load_config()
IDENTITY_PATH = CONFIG['identity_file']


# ---------- HTTP ----------

# 访问自家服务器不走系统代理(本机 Clash 等代理对非标端口可能 502)
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(method, path, body=None, headers=None):
    """调服务端。返回 (status_code, json_or_None)。网络异常时抛出带排查建议的 RuntimeError。"""
    url = CONFIG['api']['base'].rstrip('/') + path
    data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json; charset=utf-8')
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with OPENER.open(req, timeout=CONFIG['api']['timeout']) as resp:
            raw = resp.read().decode('utf-8')
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', errors='replace')
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {'error': {'code': 'BAD_RESPONSE', 'message': raw[:300]}}
    except urllib.error.URLError as e:
        raise RuntimeError(
            f'连不上服务器 {url}: {e.reason}。排查: 1)腾讯云控制台防火墙放行 TCP 3210 了吗 '
            f'2)服务器上 pm2 status 里 nearby-you-api 是不是 online')


def fail_http(status, payload):
    """把服务端错误转成带人话提示的 RuntimeError。"""
    err = (payload or {}).get('error') or {}
    return RuntimeError(f'HTTP {status} [{err.get("code", "?")}] {err.get("message", "")}')


def print_result(obj):
    print('RESULT_JSON: ' + json.dumps(obj, ensure_ascii=False))


# ---------- identity.json 管理 ----------

def load_identity(required=False):
    if not os.path.exists(IDENTITY_PATH):
        if required:
            raise RuntimeError(
                f'本地身份文件不存在: {IDENTITY_PATH}\n'
                f'首次使用请先走「上报资料」流程(create); 若曾删除过该文件则 secret 已丢, 需服务器管理员救援(见服务器 README)。')
        return None
    try:
        with open(IDENTITY_PATH, encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        raise RuntimeError(f'身份文件损坏({IDENTITY_PATH}): {e}')


def save_identity(identity):
    """原子写: 先写临时文件再 rename, 避免写一半断电损坏身份。"""
    d = os.path.dirname(IDENTITY_PATH)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.identity_', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(identity, f, ensure_ascii=False, indent=2)
        os.replace(tmp, IDENTITY_PATH)  # Windows 上 os.replace 可原子覆盖
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def auth_headers(identity):
    return {'X-Auth-Secret': identity['secret']}


# ---------- 子命令 ----------

def cmd_health(args):
    status, payload = api('GET', '/api/health')
    if status != 200:
        raise fail_http(status, payload)
    amap = payload.get('amap_configured')
    print(f"[OK] 服务在线: {payload.get('service')} | 已注册资料: {payload.get('profiles')} 条 | "
          f"高德key: {'已配置' if amap else '未配置(地址解析降级,不影响上报)'}")
    print_result(payload)


def cmd_ip_loc(args):
    status, payload = api('GET', '/api/ip-location')
    if status != 200:
        raise fail_http(status, payload)
    print(f"[OK] IP 定位: {payload.get('country', '')}{payload.get('region', '')}{payload.get('city', '')} "
          f"(城市级精度, 来源 {payload.get('source')})")
    print_result(payload)


def cmd_geocode(args):
    if args.city:
        status, payload = api('GET', '/api/geocode?' + urllib.parse.urlencode({'city': args.city}))
    else:
        status, payload = api('GET', '/api/geocode?' + urllib.parse.urlencode({'lat': args.lat, 'lon': args.lon}))
    if status != 200:
        raise fail_http(status, payload)
    if payload.get('source') == 'none':
        print(f"[WARN] {payload.get('note', '服务器未配置高德key')}")
    else:
        print(f"[OK] 地理编码: {payload.get('address') or '(无地址)'} city={payload.get('city')}")
    print_result(payload)


def cmd_create(args):
    body = read_body(args, 'create')
    for field in ('nickname', 'location'):
        if field not in body:
            raise RuntimeError(f'create 请求缺少必填字段: {field}')
    status, payload = api('POST', '/api/profile', body)
    if status != 201:
        raise fail_http(status, payload)
    identity = {
        'id': payload['id'],
        'secret': payload['secret'],  # 明文 secret 仅此一次,必须立刻保存
        'profile_cache': pick_profile(payload.get('profile', {})),
        'location_cache': pick_location(payload.get('profile', {})),
        'created_at': payload.get('profile', {}).get('created_at'),
    }
    save_identity(identity)
    print(f"[OK] 资料创建成功,身份已保存到 {IDENTITY_PATH} (勿删除! secret 丢了要找服务器管理员)")
    print_result(payload)


def cmd_update(args):
    identity = load_identity(required=True)
    body = read_body(args, 'update')
    status, payload = api('PUT', f"/api/profile/{urllib.parse.quote(identity['id'])}", body,
                          headers=auth_headers(identity))
    if status != 200:
        raise fail_http(status, payload)
    profile = payload.get('profile', {})
    identity['profile_cache'] = pick_profile(profile)
    identity['location_cache'] = pick_location(profile)
    save_identity(identity)
    print('[OK] 资料已更新(本地缓存同步刷新)')
    print_result(payload)


def cmd_delete(args):
    identity = load_identity(required=True)
    if not args.yes:
        raise RuntimeError('删除是不可逆操作,请加 --yes 确认(且 SKILL.md 流程要求先经用户二次确认)')
    status, payload = api('DELETE', f"/api/profile/{urllib.parse.quote(identity['id'])}",
                          headers=auth_headers(identity))
    if status != 200:
        raise fail_http(status, payload)
    if os.path.exists(IDENTITY_PATH):
        os.remove(IDENTITY_PATH)
    print(f'[OK] 资料已删除,IP 名额已释放,本地身份文件已清除({IDENTITY_PATH})')
    print_result({'ok': True})


def cmd_nearby(args):
    identity = load_identity()
    lat, lon = args.lat, args.lon
    if lat is None or lon is None:
        cache = (identity or {}).get('location_cache') or {}
        if cache.get('lat') is not None and cache.get('lon') is not None:
            lat, lon = cache['lat'], cache['lon']
            print(f"[INFO] 未指定坐标,使用上次上报位置: {cache.get('address') or cache.get('city') or f'{lat},{lon}'}")
        else:
            raise RuntimeError('没有可用坐标: 请传 --lat --lon,或先走一次上报流程建立位置缓存')
    qs = {'lat': lat, 'lon': lon,
          'radius_km': args.radius if args.radius is not None else CONFIG['default']['radius_km'],
          'limit': args.limit if args.limit is not None else CONFIG['default']['limit']}
    if identity:
        qs['exclude'] = identity['id']  # 不显示自己
    status, payload = api('GET', '/api/nearby?' + urllib.parse.urlencode(qs))
    if status != 200:
        raise fail_http(status, payload)
    n = payload.get('count', 0)
    wanted = int(qs['limit'])
    if payload.get('truncated'):
        note = '(超出 limit 已截断)'
    elif n < wanted:
        note = f'(不足 {wanted} 人,可提示用户扩大半径)'
    else:
        note = ''
    print(f"[OK] 半径 {payload.get('radius_km')}km 内找到 {n} 人{note}")
    print_result(payload)


def cmd_whoami(args):
    identity = load_identity(required=True)
    masked = '*(打码)*'
    secret = identity.get('secret', '')
    if len(secret) >= 8:
        masked = secret[:4] + '...' + secret[-4:]
    out = {'id': identity.get('id'), 'secret_masked': masked,
           'profile_cache': identity.get('profile_cache'),
           'location_cache': identity.get('location_cache'),
           'identity_file': IDENTITY_PATH}
    print(f"[OK] 本地身份 (secret 已打码,明文只在 {IDENTITY_PATH})")
    print_result(out)


# ---------- 工具 ----------

def pick_profile(p):
    return {k: p.get(k, '') for k in ('nickname', 'bio', 'agent_info', 'contact')}


def pick_location(p):
    return {'lat': p.get('lat'), 'lon': p.get('lon'), 'address': p.get('address', ''),
            'city': p.get('city', ''), 'source': p.get('loc_source', '')}


def read_body(args, name):
    """读请求 JSON: --file 优先(推荐,UTF-8 文件无编码歧义),否则 stdin。"""
    path = getattr(args, 'file', None)
    if path:
        try:
            with open(path, encoding='utf-8-sig') as f:  # utf-8-sig 兼容 PS 写出的 BOM
                raw = f.read().strip()
        except OSError as e:
            raise RuntimeError(f'读文件失败 {path}: {e}')
    else:
        raw = sys.stdin.read().strip()
    if not raw:
        raise RuntimeError(f'{name} 需要 JSON(--file 文件或 stdin,由 Claude 组装)')
    try:
        return json.loads(raw)
    except ValueError as e:
        raise RuntimeError(f'JSON 解析失败(检查是否含未转义引号/编码损坏): {e}')


def main():
    p = argparse.ArgumentParser(description='「附近的你」API 客户端')
    sub = p.add_subparsers(dest='cmd', required=True)

    sub.add_parser('health', help='检查服务连通性')
    sub.add_parser('ip-loc', help='服务端按来源 IP 定位')
    g = sub.add_parser('geocode', help='地理编码')
    g.add_argument('--lat', type=float)
    g.add_argument('--lon', type=float)
    g.add_argument('--city')
    c_parser = sub.add_parser('create', help='创建资料(JSON 用 --file 传,推荐)')
    c_parser.add_argument('--file', help='JSON 文件路径(UTF-8),避免管道中文编码问题')
    u_parser = sub.add_parser('update', help='修改资料(JSON 用 --file 传,自动带鉴权)')
    u_parser.add_argument('--file', help='JSON 文件路径(UTF-8)')
    d = sub.add_parser('delete', help='删除我的资料')
    d.add_argument('--yes', action='store_true', help='确认删除')
    n = sub.add_parser('nearby', help='查附近的人')
    n.add_argument('--lat', type=float)
    n.add_argument('--lon', type=float)
    n.add_argument('--radius', type=int)
    n.add_argument('--limit', type=int)
    sub.add_parser('whoami', help='查看本地身份')

    args = p.parse_args()
    handler = {'health': cmd_health, 'ip-loc': cmd_ip_loc, 'geocode': cmd_geocode,
               'create': cmd_create, 'update': cmd_update, 'delete': cmd_delete,
               'nearby': cmd_nearby, 'whoami': cmd_whoami}[args.cmd]
    try:
        handler(args)
    except RuntimeError as e:
        print(f'[ERROR] {e}')
        sys.exit(1)


if __name__ == '__main__':
    main()
