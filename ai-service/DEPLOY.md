# 云服务器配置（Ubuntu + Nginx）

云端运行 `ai-service/`。Chrome 扩展留在用户电脑上；`backend/` 不是线上服务。为方便安装，可以在服务器克隆整个仓库，实际进程只运行 `ai-service/app.py`；体验页的下载接口会读取 `easyview-extension/`，`/analyze` 的校验还会读取 `docs/drafts/ui-schema-0.3/` 和 `docs/elements.schema.json`。

公开 `GET /` 是评委体验页，`GET /download/easyview-extension.zip` 动态打包当前仓库的扩展文件。插件直接调用公开 `POST /draft`，无需体验码；服务端限制请求体、并发和调用次数。内部 `POST /analyze` 仍由 `EASYVIEW_ACCESS_TOKEN` 保护。

以下以 `api.example.com` 为例，请换成你的域名。先把域名 A/AAAA 记录指向服务器，并在云平台安全组开放 22、80、443；**不要开放 8787**。需要能访问模型服务的出站网络。

## 1. 安装代码

```bash
sudo apt update
sudo apt install -y git python3 python3-venv nginx snapd
sudo install -d -o "$USER" -g "$(id -gn)" /opt/easyview
git clone --branch backend https://github.com/kevin20070810/EasyView.git /opt/easyview
python3 -m venv /opt/easyview/.venv
/opt/easyview/.venv/bin/pip install -r /opt/easyview/ai-service/requirements.txt
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin easyview
sudo chown -R easyview:easyview /opt/easyview
```

仓库若为私有仓库，先给服务器配置只读 Deploy Key，再用 SSH 仓库地址克隆。上述 `useradd` 是一次性操作；已有 `easyview` 用户时跳过。

## 2. 密钥与 systemd

建立 `/etc/easyview/service.env`（不要放进 Git）：

```bash
sudo install -d -m 700 /etc/easyview
sudoedit /etc/easyview/service.env
sudo chmod 600 /etc/easyview/service.env
```

文件内容示例：

```ini
EASYVIEW_API_KEY=你的模型服务密钥
EASYVIEW_BASE_URL=https://api.deepseek.com/v1
EASYVIEW_MODEL=你已开通的模型ID
EASYVIEW_REASONING=off
EASYVIEW_ACCESS_TOKEN=请生成独立的长随机令牌
```

`EASYVIEW_ACCESS_TOKEN` 只保护内部 `/analyze`，插件不需要它。可用 `openssl rand -hex 32` 生成。不要把它或模型密钥写到 README、插件源码或 GitHub。

创建 `/etc/systemd/system/easyview.service`：

```ini
[Unit]
Description=EasyView AI service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=easyview
Group=easyview
WorkingDirectory=/opt/easyview
EnvironmentFile=/etc/easyview/service.env
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/opt/easyview/.venv/bin/python /opt/easyview/ai-service/app.py --host 127.0.0.1 --port 8787
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now easyview
sudo systemctl status easyview
curl http://127.0.0.1:8787/health
```

`/health` 返回 `ai_configured: true` 表示模型密钥已被进程读取；这不是模型质量或额度检查。

## 3. Nginx 与 HTTPS

创建 `/etc/nginx/sites-available/easyview`，替换域名：

```nginx
limit_req_zone $binary_remote_addr zone=easyview_per_ip:10m rate=10r/m;

server {
    listen 80;
    server_name api.example.com;
    client_max_body_size 1m;

    location / {
        limit_req zone=easyview_per_ip burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_connect_timeout 5s;
        proxy_read_timeout 130s;
    }
}
```

启用站点：

```bash
sudo ln -s /etc/nginx/sites-available/easyview /etc/nginx/sites-enabled/easyview
sudo nginx -t
sudo systemctl reload nginx
```

按 [Certbot 的 Nginx 指南](https://certbot.eff.org/instructions?ws=nginx&os=snap) 安装 Certbot，然后执行：

```bash
sudo certbot --nginx -d api.example.com
sudo certbot renew --dry-run
```

确认 `https://api.example.com/health` 可访问；无令牌、空说明书的 `POST /draft` 应返回 400，而无令牌的 `POST /analyze` 应返回 401。Nginx 负责 TLS、按来源限流与请求体大小；Python 服务额外限制公开模型调用量，只监听 `127.0.0.1`。

## 4. 使用 Chrome 扩展

官方演示扩展默认连接 `https://ev.jvda.online`，安装后打开普通网页即可点击「敬老版」。若部署到其他域名，本地调试时可在扩展 Service Worker DevTools 中设置 `easyview.aiEndpoint`；无需给插件分发令牌。扩展现有 `https://*/*` host permission 已允许请求 HTTPS 域名，不需把模型密钥打包进扩展。

## 范围

这套配置适合黑客松公开体验。进程内限额会在重启后清空，也不能代替云端预算和监控；长期面向公众开放前，还需要按用户的额度、滥用防护和运维监控。
