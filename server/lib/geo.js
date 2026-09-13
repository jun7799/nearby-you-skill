// geo.js — 距离计算与坐标系转换
// 约定：数据库统一存 WGS-84（Windows GPS / ip-api 返回的原始坐标系）
// 调高德接口前必须转 GCJ-02（国测局加密坐标），否则地址偏移几百米

const PI = Math.PI;
const EARTH_R = 6371; // km
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

// Haversine 球面距离（km）
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 粗略判断是否在中国境内（境外坐标高德不做偏移，直接原样返回）
function inChina(lat, lon) {
  return lon >= 72.004 && lon <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLon(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

function gcjDelta(lat, lon) {
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * PI);
  return { dLat, dLon };
}

// WGS-84 -> GCJ-02（调高德前用）
function wgs84ToGcj02(lat, lon) {
  if (!inChina(lat, lon)) return { lat, lon };
  const { dLat, dLon } = gcjDelta(lat, lon);
  return { lat: lat + dLat, lon: lon + dLon };
}

// GCJ-02 -> WGS-84（一次迭代近似逆推，误差 1-2 米，足够）
function gcj02ToWgs84(lat, lon) {
  if (!inChina(lat, lon)) return { lat, lon };
  const g = wgs84ToGcj02(lat, lon);
  return { lat: lat * 2 - g.lat, lon: lon * 2 - g.lon };
}

module.exports = { haversineKm, wgs84ToGcj02, gcj02ToWgs84 };
