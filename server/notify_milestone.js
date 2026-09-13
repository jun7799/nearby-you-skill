// notify_milestone.js — 用户数里程碑邮件提醒
// 每当真实注册数(排除 fake- 前缀测试数据)跨过 5 的倍数,发一封邮件通知站长。
// cron 每 15 分钟跑一次;状态存 data/milestone.state,重复跑不会重复发。
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
  const targetMilestone = Math.floor(count / STEP) * STEP;

  if (targetMilestone > lastNotified) {
    const recent = db.prepare(
      "SELECT nickname, city, created_at FROM profiles WHERE id NOT LIKE 'fake-%' ORDER BY created_at DESC LIMIT 3"
    ).all().map((r) => `  · ${r.nickname}(${r.city || '未知城市'}) ${r.created_at}`);
    const subject = `「附近的你」用户数达到 ${targetMilestone} 人`;
    const body = [
      `注册用户数刚刚跨过 ${targetMilestone} 人(当前 ${count} 人)。`,
      '',
      '最近注册的 3 位:',
      ...recent,
      '',
      `时间: ${new Date().toISOString()}`,
      '—— nearby-you-api 里程碑提醒(cron 每 15 分钟检查)',
    ].join('\n');
    if (sendMail(conf, subject, body)) {
      fs.writeFileSync(STATE_PATH, String(targetMilestone));
      console.log(`[OK] 已发里程碑邮件: ${targetMilestone} 人 (当前 ${count})`);
    }
  } else {
    console.log(`[INFO] 当前 ${count} 人,未跨过新里程碑(上次通知: ${lastNotified})`);
  }
}

main();
