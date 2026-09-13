# nearby-you-api 运维手册

「附近的你」skill 的云端 API。腾讯云 Ubuntu 服务器，pm2 托管，端口 3000。

## 基本信息

| 项目 | 值 |
|---|---|
| 项目路径 | `/home/ubuntu/nearby-you-api` |
| pm2 进程名 | `nearby-you-api` |
| 端口 | HTTP 3210（IP 调试兜底）+ HTTPS 443（`https://nearby.baihehuakai666.asia`，防火墙两个都放行） |
| 数据库 | `data/data.db`（SQLite，WAL 模式，运行时自动创建） |
| 依赖 | express@4 + better-sqlite3（Node >= 16） |

## HTTPS 证书（acme.sh + Cloudflare DNS-01）

- 证书：Let's Encrypt，DNS-01 验证（不占 80 端口，大陆服务器未备案也可签发）
- 文件：`certs/nearby.baihehuakai666.asia.key` + `certs/fullchain.cer`（不入 git）
- 续期：acme.sh 定时任务自动续（60 天一续），续完自动 `pm2 restart nearby-you-api`（install-cert 时已挂 reloadcmd）
- Cloudflare Token 存于 `~/.acme.sh/account.conf`（服务器文件，注意权限）
- **node 升级后要重打 443 绑定权限**：`sudo setcap 'cap_net_bind_service=+ep' /usr/bin/node`
- 证书未就位时服务自动降级为仅 HTTP 3210，不影响启动

## 常用命令

```bash
pm2 status                        # 状态
pm2 logs nearby-you-api --lines 50  # 日志
pm2 restart nearby-you-api        # 重启（改 AMAP_KEY 重启时加 --update-env）
pm2 env nearby-you-api | grep AMAP_KEY  # 确认 key 已透传
```

## 首次部署 / 更新代码

```bash
# 本地（仓库根目录下执行；<server> 换成你的服务器地址）
scp -r server/* ubuntu@<your-server>:/home/ubuntu/nearby-you-api/

# 服务器
cd /home/ubuntu/nearby-you-api
npm install          # better-sqlite3 编译失败时: sudo apt install -y build-essential python3 后重试
AMAP_KEY=你的key pm2 start ecosystem.config.js   # 首次（key 可选）
pm2 save

# 更新代码后
pm2 restart nearby-you-api
```

## AMAP_KEY（高德开放平台 Web 服务 key）

- 申请：https://console.amap.com → 应用管理 → 创建应用 → 添加 key（类型选「Web服务」），免费额度个人够用
- 作用：经纬度↔中文地址互转。**不配置也能跑**：系统降级为只存坐标，地址栏为空
- 修改 key：`AMAP_KEY=新key pm2 restart nearby-you-api --update-env`

## secret 丢失救援（无账号体系的固有死锁）

用户删了 `identity.json` 就丢了 secret，自己删不掉资料。管理员按 id 手动清（库里只有 IP 哈希，认人靠昵称+时间）：

```bash
cd /home/ubuntu/nearby-you-api
sqlite3 data/data.db "SELECT id, nickname, updated_at FROM profiles;"
sqlite3 data/data.db "DELETE FROM profiles WHERE id='xxx';"
```

（硬删除会同时释放该 IP 的创建名额。）

## IP_SALT（IP 哈希盐）

- 存放：`~/.nearby-you-ip-salt`（600 权限），首次部署自动生成
- 作用：库里存 `sha256(ip:盐)`，data.db 泄露时不直接暴露用户 IP
- **换盐 = 所有 IP 防灌水名额重置**（已有资料的增删改不受影响，靠 UUID+secret），没事别动它
- 丢了/想重置：`rm ~/.nearby-you-ip-salt` 后重新部署会生成新的

## 限流（防爬取/刷配额）

内存固定窗口，重启清零：全局 30 次/分/IP（health 豁免），`nearby` / `geocode` / `ip-location` 额外各 10 次/分/IP，超限 429。

## 已知限制（设计取舍，非遗漏）

1. **一个 IP 只能创建一条资料**——防灌水手段（按加盐哈希查重）；同一宽带/公司多设备共享公网 IP 会被拦，用户已知情接受
2. **裸 HTTP（自部署默认）**——官方服务器已上 HTTPS（DNS-01 证书，见上文）；自部署无域名时仍是 IP:3210 明文，传输层风险自担
3. **本机 curl 测试**——服务器上 curl 时 req.ip 是 127.0.0.1，也只能建一条，测试用「建→删→再建」循环
4. **ip-api 免费限流** 45 次/分钟——服务端已做 3s 超时 + 10 分钟缓存
5. **坐标系**——库统一存 WGS-84；调高德前转 GCJ-02（`lib/geo.js`），不转地址偏 ~500m
6. **fail2ban** 已装（SSH 爆破自动封）；sshd 密码登录暂未禁用（read-image-app 的 deploy.js 依赖密码 SSH，需协调后再关）
