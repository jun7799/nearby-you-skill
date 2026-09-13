// server.js — 「附近的你」API 服务入口
// 端口：3000（pm2 进程名 nearby-you-api）
// 红线：任何响应绝不输出 source_ip / secret_hash；AMAP_KEY / SSH 密码绝不写进代码

const express = require('express');
const crypto = require('crypto');
const db = require('./lib/db');
const geo = require('./lib/geo');
const upstream = require('./lib/upstream');

const app = express();
const PORT = process.env.PORT || 3000;

// IP 哈希盐(存服务器 ~/.nearby-you-ip-salt,600权限):库泄露时不直接暴露用户 IP。
// 没有盐就拒绝启动——避免有人裸环境跑起来退化成明文 IP
const IP_SALT = process.env.IP_SALT || '';
if (!IP_SALT) {
  console.error('[ERROR] 缺少环境变量 IP_SALT(随机盐)。生成: head -c 32 /dev/urandom | od -An -tx1 | tr -d " \\n" > ~/.nearby-you-ip-salt && chmod 600 ~/.nearby-you-ip-salt');
  process.exit(1);
}
function ipHash(ip) {
  return crypto.createHash('sha256').update(String(ip) + ':' + IP_SALT).digest('hex');
}

// 直连部署（无反向代理），保持 trust proxy 默认 false，req.ip 即真实来源 IP
app.use(express.json({ limit: '100kb' }));

// ---- 工具 ----

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function err(res, e) {
  const status = e instanceof ApiError ? e.status : 500;
  const code = e instanceof ApiError ? e.code : 'INTERNAL_ERROR';
  const message = e instanceof ApiError ? e.message : `服务器内部错误：${e.message}`;
  return res.status(status).json({ error: { code, message } });
}

function clientIp(req) {
  return String(req.ip || '').replace(/^::ffff:/, '');
}

// 响应白名单序列化 —— source_ip / secret_hash 永远不出库房
function safeProfile(row, extra = {}) {
  return {
    id: row.id,
    nickname: row.nickname,
    bio: row.bio,
    agent_info: row.agent_info,
    contact: row.contact,
    lat: row.lat,
    lon: row.lon,
    address: row.address,
    city: row.city,
    loc_source: row.loc_source,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extra,
  };
}

function cleanText(v, maxLen, field) {
  const s = String(v == null ? '' : v).trim();
  if (s.length > maxLen) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 超长（最多 ${maxLen} 字）`);
  return s;
}

// 校验并解析 location 块，统一输出 { lat, lon, address, city, loc_source }
// - source = gps | ip：必须带 WGS-84 坐标，address/city 缺失时服务端调高德补
// - source = manual：必须带 city，服务端正向解析出坐标（高德不可用时该链路失败）
async function resolveLocation(loc) {
  if (!loc || typeof loc !== 'object') {
    throw new ApiError(400, 'VALIDATION_ERROR', '缺少 location 字段');
  }
  const source = String(loc.source || '').trim();

  if (source === 'manual') {
    const city = cleanText(loc.city, 60, 'city');
    if (!city) throw new ApiError(400, 'VALIDATION_ERROR', 'manual 定位必须提供 city');
    let resolved;
    try {
      resolved = await upstream.amapGeo(city);
    } catch (e) {
      throw new ApiError(502, 'GEOCODE_FAILED', `城市「${city}」解析失败：${e.message}`);
    }
    if (!resolved) {
      throw new ApiError(502, 'GEOCODE_FAILED', '服务器未配置 AMAP_KEY，无法解析城市名，请改用 GPS/IP 定位');
    }
    return { lat: resolved.lat, lon: resolved.lon, address: resolved.address, city: resolved.city, loc_source: 'manual' };
  }

  if (source !== 'gps' && source !== 'ip') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'location.source 必须是 gps / ip / manual');
  }
  const lat = Number(loc.lat);
  const lon = Number(loc.lon);
  if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'lat/lon 缺失或超出正常范围');
  }
  let address = cleanText(loc.address, 200, 'address');
  let city = cleanText(loc.city, 60, 'city');
  if (!address || !city) {
    try {
      const r = await upstream.amapRegeo(lat, lon); // null = 没配 key，按无地址处理
      if (r) {
        if (!address) address = r.address || '';
        if (!city) city = r.city || '';
      }
    } catch {
      // 逆地理失败不阻塞上报，只存坐标
    }
  }
  return { lat, lon, address, city, loc_source: source };
}

// PUT/DELETE 鉴权：X-Auth-Secret 的 sha256 与库中 secret_hash 常数时间比对
function requireAuth(req, row) {
  const given = db.sha256(req.get('X-Auth-Secret') || '');
  const stored = row.secret_hash || '';
  const a = Buffer.from(given);
  const b = Buffer.from(stored);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(401, 'BAD_SECRET', 'secret 不正确（identity.json 丢失或损坏？救援办法见服务器 README）');
  }
}

// ---- 限流（内存版固定窗口，防爬取/刷高德配额；重启清零，够用）----
const rateBuckets = new Map(); // "名字:ip" -> { windowStart, count }
function rateLimit(name, maxN, windowMs = 60000) {
  return (req, res, next) => {
    const key = name + ':' + clientIp(req);
    const now = Date.now();
    if (rateBuckets.size > 5000) { // 桶多了顺手清理过期的，防内存涨
      for (const [k, v] of rateBuckets) {
        if (now - v.windowStart >= windowMs) rateBuckets.delete(k);
      }
    }
    let b = rateBuckets.get(key);
    if (!b || now - b.windowStart >= windowMs) {
      b = { windowStart: now, count: 0 };
      rateBuckets.set(key, b);
    }
    b.count += 1;
    if (b.count > maxN) {
      return err(res, new ApiError(429, 'RATE_LIMITED', `请求太频繁（每分钟限 ${maxN} 次），稍等一分钟再试`));
    }
    next();
  };
}

// 全局兜底限流（health 探活豁免）
app.use('/api', (req, res, next) => (req.path === '/health' ? next() : rateLimit('global', 30)(req, res, next)));

// ---- 路由 ----

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'nearby-you-api',
    time: new Date().toISOString(),
    amap_configured: Boolean(upstream.AMAP_KEY),
    profiles: db.countAll(),
  });
});

// 创建资料（一个 IP 只能一条，按加盐哈希查重；明文 secret 仅本次响应出现）
app.post('/api/profile', async (req, res) => {
  try {
    const ip = clientIp(req);
    if (db.countByIpHash(ipHash(ip)) > 0) {
      throw new ApiError(409, 'IP_TAKEN',
        `该 IP（${ip}）已创建过资料。是自己的旧资料请用「更新资料」；secret 丢了见服务器 README 救援。` +
        `（注意：同一宽带/公司网络下的多台设备共享一个公网 IP，属于已知限制）`);
    }
    const body = req.body || {};
    const nickname = cleanText(body.nickname, 30, 'nickname');
    if (!nickname) throw new ApiError(400, 'VALIDATION_ERROR', 'nickname 必填');
    const bio = cleanText(body.bio, 500, 'bio');
    const agentInfo = cleanText(body.agent_info, 200, 'agent_info');
    const contact = cleanText(body.contact, 200, 'contact');
    const loc = await resolveLocation(body.location);

    const id = db.newId();
    const secret = db.newSecret();
    const now = db.nowIso();
    db.insertProfile({
      id, secret_hash: db.sha256(secret),
      nickname, bio, agent_info: agentInfo, contact,
      lat: loc.lat, lon: loc.lon, address: loc.address, city: loc.city,
      loc_source: loc.loc_source, ip_hash: ipHash(ip),
      created_at: now, updated_at: now,
    });
    res.status(201).json({ id, secret, profile: safeProfile(db.getProfile(id)) });
  } catch (e) {
    err(res, e);
  }
});

// 修改资料（部分字段；location 给了就整套替换）
app.put('/api/profile/:id', async (req, res) => {
  try {
    const row = db.getProfile(req.params.id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '资料不存在（已被删除？）');
    requireAuth(req, row);

    const body = req.body || {};
    const fields = { updated_at: db.nowIso() };
    if (body.nickname !== undefined) {
      const nickname = cleanText(body.nickname, 30, 'nickname');
      if (!nickname) throw new ApiError(400, 'VALIDATION_ERROR', 'nickname 不能为空');
      fields.nickname = nickname;
    }
    if (body.bio !== undefined) fields.bio = cleanText(body.bio, 500, 'bio');
    if (body.agent_info !== undefined) fields.agent_info = cleanText(body.agent_info, 200, 'agent_info');
    if (body.contact !== undefined) fields.contact = cleanText(body.contact, 200, 'contact');
    if (body.location !== undefined) {
      const loc = await resolveLocation(body.location);
      Object.assign(fields, {
        lat: loc.lat, lon: loc.lon, address: loc.address, city: loc.city, loc_source: loc.loc_source,
      });
    }
    db.updateProfile(row.id, fields);
    res.json({ profile: safeProfile(db.getProfile(row.id)) });
  } catch (e) {
    err(res, e);
  }
});

// 删除资料（硬删除，同时释放该 IP 的创建名额）
app.delete('/api/profile/:id', (req, res) => {
  try {
    const row = db.getProfile(req.params.id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '资料不存在（可能已被删除）');
    requireAuth(req, row);
    db.deleteProfile(row.id);
    res.json({ ok: true });
  } catch (e) {
    err(res, e);
  }
});

// 查附近：按距离升序，白名单字段 + distance_km；exclude 用来排除自己
app.get('/api/nearby', rateLimit('nearby', 10), (req, res) => {
  try {
    const q = req.query || {};
    const lat = Number(q.lat);
    const lon = Number(q.lon);
    if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'lat/lon 必填且需为合法数值');
    }
    const radiusKm = Math.min(Math.max(Number(q.radius_km) || 50, 1), 2000);
    const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 50);
    const exclude = String(q.exclude || '');

    const withDist = db.allProfiles()
      .filter((r) => r.id !== exclude && r.lat != null && r.lon != null)
      .map((r) => ({ row: r, distance_km: Math.round(geo.haversineKm(lat, lon, r.lat, r.lon) * 10) / 10 }));
    const inRange = withDist.filter((x) => x.distance_km <= radiusKm)
      .sort((a, b) => a.distance_km - b.distance_km);
    const truncated = inRange.length > limit;
    const results = inRange.slice(0, limit).map((x) => safeProfile(x.row, { distance_km: x.distance_km }));

    res.json({ radius_km: radiusKm, count: results.length, results, truncated });
  } catch (e) {
    err(res, e);
  }
});

// 服务端按请求来源 IP 定位（skill 端定位降级链的第二级；也耗高德配额，限流）
app.get('/api/ip-location', rateLimit('iploc', 10), async (req, res) => {
  try {
    const ip = clientIp(req);
    res.json(await upstream.ipLocate(ip));
  } catch (e) {
    err(res, new ApiError(502, 'IP_LOCATE_FAILED', `IP 定位不可用：${e.message}。请降级为手动填写城市`));
  }
});

// 地理编码辅助：?lat=&lon= 逆地理 / ?city= 正向（走高德配额，严格限流防刷）
app.get('/api/geocode', rateLimit('geocode', 10), async (req, res) => {
  try {
    if (!upstream.AMAP_KEY) {
      return res.json({
        address: null, city: null, lat: null, lon: null, source: 'none',
        note: '服务器未配置 AMAP_KEY，仅支持坐标存储（不影响上报）',
      });
    }
    const q = req.query || {};
    if (q.city) {
      const r = await upstream.amapGeo(String(q.city));
      return res.json({ address: r.address, city: r.city, lat: r.lat, lon: r.lon, source: 'amap' });
    }
    const lat = Number(q.lat);
    const lon = Number(q.lon);
    if (isFinite(lat) && isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      const r = await upstream.amapRegeo(lat, lon);
      return res.json(r || { address: null, city: null, source: 'none' });
    }
    throw new ApiError(400, 'VALIDATION_ERROR', '需要 ?lat=&lon= 或 ?city= 参数');
  } catch (e) {
    if (e instanceof ApiError) return err(res, e);
    return err(res, new ApiError(502, 'GEOCODE_UPSTREAM_FAILED', `地理编码失败：${e.message}`));
  }
});

// ---- 兜底 ----

app.use((req, res) => err(res, new ApiError(404, 'NOT_FOUND', '接口不存在')));
// eslint-disable-next-line no-unused-vars
app.use((e, req, res, next) => {
  if (e.type === 'entity.parse.failed') {
    return err(res, new ApiError(400, 'BAD_JSON', '请求体不是合法 JSON'));
  }
  err(res, e);
});

app.listen(PORT, () => {
  console.log(`[OK] nearby-you-api 已启动，端口 ${PORT}，AMAP_KEY ${upstream.AMAP_KEY ? '已配置' : '未配置（仅存坐标，地址解析降级）'}`);
});
