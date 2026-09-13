// upstream.js — 上游服务封装（ip-api.com IP 定位 + 高德地理编码）
// 全部走 Node 内置 http/https 模块（不赌服务器 Node 版本有没有 fetch）
// 所有上游请求 3 秒超时；IP 定位结果内存缓存 10 分钟（ip-api 免费版限流 45 次/分钟）

const http = require('http');
const https = require('https');
const geo = require('./geo');

const UPSTREAM_TIMEOUT_MS = 3000;
const IP_CACHE_TTL_MS = 10 * 60 * 1000;
const AMAP_KEY = process.env.AMAP_KEY || '';

// ---- 基础请求 ----

function getJSON(url, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`上游返回 HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 256 * 1024) {
          req.destroy();
          reject(new Error('上游响应过大'));
        }
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('上游返回非法 JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('上游请求超时')));
    req.on('error', reject);
  });
}

// ---- IP 定位（ip-api.com 免费版，仅 HTTP，无 key）----

const ipCache = new Map(); // ip -> { ts, data }

function isPrivateIp(ip) {
  return (
    ip === '127.0.0.1' || ip === '::1' || ip === '' ||
    /^10\./.test(ip) || /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

async function ipLocate(ip) {
  if (isPrivateIp(ip)) {
    throw new Error(`IP ${ip || '(空)'} 是内网地址，无法公网定位（在服务器本机测试属正常现象）`);
  }
  const hit = ipCache.get(ip);
  if (hit && Date.now() - hit.ts < IP_CACHE_TTL_MS) return hit.data;

  let result = null;
  // 主路：高德 IP 定位（国内直连稳，key 现成，城市级精度）
  if (AMAP_KEY) {
    try {
      const data = await getJSON(`https://restapi.amap.com/v3/ip?key=${AMAP_KEY}&ip=${encodeURIComponent(ip)}`);
      if (String(data.status) === '1' && data.rectangle) {
        const c = rectangleCenter(data.rectangle); // GCJ-02 城市中心
        const w = geo.gcj02ToWgs84(c.lat, c.lon);
        result = {
          ip,
          country: '中国',
          region: Array.isArray(data.province) ? '' : data.province || '',
          city: Array.isArray(data.city) ? '' : data.city || '',
          lat: w.lat,
          lon: w.lon,
          source: 'amap-ip',
        };
      }
    } catch {
      // 高德失败，走 ip-api 兜底
    }
  }
  // 兜底：ip-api.com（国外服务，国内服务器可能超时；无 key 部署时的唯一路）
  if (!result) {
    const data = await getJSON(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,message,country,regionName,city,lat,lon`
    );
    if (data.status !== 'success') {
      throw new Error(data.message || 'ip-api 返回失败');
    }
    result = {
      ip,
      country: data.country || '',
      region: data.regionName || '',
      city: data.city || '',
      lat: data.lat,
      lon: data.lon,
      source: 'ip-api',
    };
  }
  ipCache.set(ip, { ts: Date.now(), data: result });
  return result;
}

// 高德 rectangle "minLon,minLat;maxLon,maxLat" -> 中心点 {lat, lon}
function rectangleCenter(rect) {
  const [p1, p2] = String(rect).split(';');
  const [lon1, lat1] = p1.split(',').map(Number);
  const [lon2, lat2] = p2.split(',').map(Number);
  return { lat: (lat1 + lat2) / 2, lon: (lon1 + lon2) / 2 };
}

// ---- 高德 ----

// 高德的 city 字段坑：直辖市/省直辖县可能返回空数组 []，统一转字符串并用 province 兜底
function pickCity(comp, fallback) {
  let city = Array.isArray(comp && comp.city) ? '' : (comp && comp.city) || '';
  if (!city && comp && comp.province && !Array.isArray(comp.province)) city = comp.province;
  return city || fallback || '';
}

// 逆地理：WGS-84 经纬度 -> 中文地址（内部先转 GCJ-02）
// 返回 null 表示"没配 key / 解析不了"，调用方按可选增强处理，不阻塞上报
async function amapRegeo(lat, lon) {
  if (!AMAP_KEY) return null;
  const g = geo.wgs84ToGcj02(lat, lon);
  // 高德 location 参数是"经度,纬度"顺序（lon 在前），这是官方文档明确的坑
  const loc = `${g.lon.toFixed(6)},${g.lat.toFixed(6)}`;
  const data = await getJSON(
    `https://restapi.amap.com/v3/geocode/regeo?key=${AMAP_KEY}&location=${loc}&extensions=base`
  );
  if (String(data.status) !== '1' || !data.regeocode) {
    throw new Error(data.info || '高德 regeo 失败');
  }
  return {
    address: data.regeocode.formatted_address || '',
    city: pickCity(data.regeocode.addressComponent, ''),
    source: 'amap',
  };
}

// 正向地理：城市名 -> WGS-84 坐标（高德返回 GCJ-02，入库前转回）
async function amapGeo(city) {
  if (!AMAP_KEY) return null;
  const data = await getJSON(
    `https://restapi.amap.com/v3/geocode/geo?key=${AMAP_KEY}&address=${encodeURIComponent(city)}`
  );
  if (String(data.status) !== '1' || !data.geocodes || data.geocodes.length === 0) {
    throw new Error(data.info || `高德找不到城市「${city}」`);
  }
  const first = data.geocodes[0];
  const [lonStr, latStr] = String(first.location).split(',');
  const w = geo.gcj02ToWgs84(parseFloat(latStr), parseFloat(lonStr));
  return {
    lat: w.lat,
    lon: w.lon,
    address: first.formatted_address || city,
    city: pickCity(first.addressComponent, city),
    source: 'amap',
  };
}

module.exports = { AMAP_KEY, ipLocate, amapRegeo, amapGeo };
