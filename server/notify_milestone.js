// notify_milestone.js — 用户数邮件提醒
// 规则:前 20 位真实用户(排除 fake- 前缀测试数据)每新增 1 人发一封;
//       20 人之后改为每跨过 5 的倍数(25/30/...)发一封。
// cron 每 15 分钟跑一次,两次检查之间若涨了多人会合并成一封信;
// 状态存 data/milestone.state(上次已通知的人数水位),重复跑不会重复发。
//
// 配置文件 /home/ubuntu/.nearby-you-mail.conf(600 权限,不进 git):
//   EMAIL_USER=你的QQ号@qq.com
//   EMAIL_PASS=QQ邮箱SMTP授权码(不是QQ密码)
//   EMAIL_TO=接收提醒的邮箱
// 配置缺失时静默退出(cron 无害)。

const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STEP = 5;
const PERSONAL_UNTIL = 20; // 前 20 人逐人提醒,之后按 5 人一档
const CONF_PATH = path.join(os.homedir(), '.nearby-you-mail.conf');
const STATE_PATH = path.join(__dirname, 'data', 'milestone.state');

function readConf() {
  if (!fs.existsSync(CONF_PATH)) return null;
  const conf = {};
  for (const line of fs.readFileSync(CONF_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) conf[m[1]] = m[2];
  }
  return conf.EMAIL_USER && conf.EMAIL_PASS && conf.EMAIL_TO ? conf : null;
}

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function sendMail(conf, subject, body) {
  const mail = [
    `From: ${conf.EMAIL_USER}`,
    `To: ${conf.EMAIL_TO}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(body),
    '',
  ].join('\r\n');
  const tmp = path.join(os.tmpdir(), `nearby-mail-${process.pid}.eml`);
  fs.writeFileSync(tmp, mail);
  try {
    execFileSync('curl', [
      '-s', '--max-time', '30',
      '--url', 'smtps://smtp.qq.com:465', '--ssl-reqd',
      // QQ SMTP 对 curl 默认的 AUTH PLAIN 兼容差(334后断连),必须显式用 LOGIN
      '--login-options', 'AUTH=LOGIN',
      '--mail-from', conf.EMAIL_USER,
      '--mail-rcpt', conf.EMAIL_TO,
      '--user', `${conf.EMAIL_USER}:${conf.EMAIL_PASS}`,
      '-T', tmp,
    ], { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error('[WARN] 邮件发送失败:', String(e.stderr || e.message).slice(0, 200));
    return false;
  } finally {
    fs.unlinkSync(tmp);
  }
}

// 判断本次要不要发信、发完后水位推进到哪。
// 返回 null=不发;数字=发(且 state 更新为该数字)。
// 跳变处理:逐人阶段跨过 20(如 19→22)先补发"第 20 位"这封,下轮再按 5 人档算。
function pickNotify(count, lastNotified) {
  if (lastNotified >= count) return null;          // 没涨
  if (count <= PERSONAL_UNTIL) return count;       // 逐人阶段:涨了就发
  if (lastNotified < PERSONAL_UNTIL) return PERSONAL_UNTIL; // 跳变补发 20 这档
  const milestone = Math.floor(count / STEP) * STEP;
  return milestone > lastNotified ? milestone : null; // 5 人档
}

function main() {
  const conf = readConf();
  if (!conf) {
    console.log('[INFO] 邮箱配置缺失(/home/ubuntu/.nearby-you-mail.conf),跳过');
    return;
  }
  const db = new Database(path.join(__dirname, 'data', 'data.db'));
  // 真实用户数:排除 fake- 前缀的测试数据
  const count = db.prepare("SELECT COUNT(*) n FROM profiles WHERE id NOT LIKE 'fake-%'").get().n;
  const lastNotified = fs.existsSync(STATE_PATH)
    ? parseInt(fs.readFileSync(STATE_PATH, 'utf8').trim(), 10) || 0 : 0;
  const target = pickNotify(count, lastNotified);

  if (target === null) {
    console.log(`[INFO] 当前 ${count} 人,未触发提醒(上次通知水位: ${lastNotified})`);
    return;
  }

  // 新增的用户(取最新的 count-lastNotified 位;跳变补发时按 target-lastNotified 截断)
  const added = Math.max(target - lastNotified, 1);
  const newcomers = db.prepare(
    "SELECT nickname, bio, city, created_at FROM profiles WHERE id NOT LIKE 'fake-%' ORDER BY created_at DESC LIMIT ?"
  ).all(added).map((r) => `  · ${r.nickname}(${r.city || '未知城市'}) ${(r.bio || '').slice(0, 40)}  ${r.created_at}`);

  const isPersonal = target <= PERSONAL_UNTIL;
  const subject = isPersonal
    ? `「附近的你」第 ${target} 位用户加入!(当前 ${count} 人,20 人内逐人提醒)`
    : `「附近的你」用户数达到 ${target} 人`;
  const body = [
    isPersonal
      ? `新用户注册,当前总数 ${count} 人(前 20 位逐人提醒,之后每 +5 人一封)。`
      : `注册用户数跨过 ${target} 人(当前 ${count} 人,之后每 +5 人提醒一次)。`,
    '',
    `本次新增 ${added} 位:`,
    ...newcomers.reverse(), // 按注册时间正序展示
    '',
    `时间: ${new Date().toISOString()}`,
    '—— nearby-you-api 提醒(cron 每 15 分钟检查)',
  ].join('\n');

  if (sendMail(conf, subject, body)) {
    fs.writeFileSync(STATE_PATH, String(target));
    console.log(`[OK] 已发提醒邮件: 水位 ${lastNotified} -> ${target} (当前 ${count})`);
  }
}

main();
