// pm2 配置 —— 密钥类环境变量不硬编码:
//   AMAP_KEY: 高德 key,部署时 shell 环境变量透传
//   IP_SALT:  IP 哈希盐,从服务器文件 ~/.nearby-you-ip-salt(600权限)读取,
//             重启/恢复不依赖人记得带环境变量
// 启动(全新,注意 restart --update-env 有 daemon 求值坑,注入不生效):
//   AMAP_KEY=你的key pm2 start ecosystem.config.js && pm2 save
const fs = require('fs');

const SALT_FILE = '/home/ubuntu/.nearby-you-ip-salt';
const IP_SALT = fs.existsSync(SALT_FILE)
  ? fs.readFileSync(SALT_FILE, 'utf8').trim()
  : (process.env.IP_SALT || '');

module.exports = {
  apps: [
    {
      name: 'nearby-you-api',
      script: 'server.js',
      cwd: '/home/ubuntu/nearby-you-api',
      env: {
        PORT: 3210, // 3000 被 thyroid-reader 占用，用 3210
        AMAP_KEY: process.env.AMAP_KEY || '',
        IP_SALT,
      },
    },
  ],
};
