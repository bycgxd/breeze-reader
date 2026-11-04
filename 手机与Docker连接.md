# 手机与 Docker 连接 · 1.7.0

## 本机已部署方案

手机/其他电脑的酒馆轻声插件 → http://192.168.31.178:8790 → Docker 容器 breeze-reader-bridge → Windows 模型 8080。

酒馆仍是 http://192.168.31.178:8000/。连接界面在轻声面板「连接与音色管理」：服务地址填 http://192.168.31.178:8790，填入连接密钥，保存，然后点「连接轻声」。当前酒馆账号的连接设置会随酒馆设置保存；手机刷新后可加载，同一个账号无需另填。其他账号需单独填写。

连接密钥和便于复制的说明在 Windows 的 %LOCALAPPDATA%\BreezeReader\手机连接说明.txt，不随导出包分发。密钥在当前酒馆账号的轻声设置里保存，具有酒馆数据管理权限的人可以读取它。

## 每次开机

先启动 Docker Desktop 和酒馆，再运行本插件目录的「启动手机连接.bat」。它准备音色、启动/复用 Windows 模型和轻声 Docker 接口，并打开连接说明。不自动修改酒馆容器、脚本或正则。Docker 接口设置 unless-stopped 自动恢复，但 Windows 模型仍须启动；远程按钮不跨设备运行启动脚本。

现有 Windows Vulkan 模型没有搬入 Linux 容器；Docker 部署的是 Python 桥接接口，镜像 python:3.12-alpine，无新增 Python 包。Windows 模型监听 0.0.0.0:8080 以便 Docker Desktop 的 host.docker.internal 连接；未创建 8080 的防火墙放行规则。模型接口本身无此桥接密钥保护，不要把 8080 或 8790 转发到公网。

## 当前范围

- 手机与 Windows 电脑在可互通的同一局域网，Windows 地址为 192.168.31.178。
- compose.yaml 将 8790 绑定到该局域网 IP，音色和插件源码只读挂载。
- 所有接口请求都校验连接密钥，浏览器额外校验明确允许的酒馆 Origin/Host；错误密钥 401，错误来源 403。网页不能调用任意命令；容器拒绝启动 Windows 程序。
- 使用其他酒馆网址、域名或不同 IP 时，修改 docker/compose.yaml 的端口绑定、--allow-host 和 --origin，再重建容器并更新插件地址。手机填服务地址，不是模型的 /v1/audio/speech 地址。
- HTTPS 酒馆不能直接混用 HTTP 接口；需给桥接增加对应 HTTPS 反向代理并允许其 Origin。未配置公网、外网或 HTTPS 入口。
- 若电脑能连手机不能连，先核对同一 Wi-Fi、路由器访客隔离和 Windows 防火墙是否阻止 Docker 的 8790。当前未自动创建防火墙规则。

## 模块变化与验证

connection.mjs 统一校验连接地址和密钥；音色发现、健康检查、PCM、启动状态与缓存键都使用同一地址。远程模式只检查模型就绪，不触发本机协议。保存连接时取消旧任务并重建插件，避免旧接口结果覆盖新配置。其他朗读功能保持原实现。

Node：connection.test.mjs、startup.test.mjs、core.test.mjs、stream.test.mjs、stage3.test.mjs。
Python bridge_test.py：3 项，包括来源/Host/密钥校验。
浏览器 stage3.html：27 项，包括远程设置保存与远程启动隔离。
真实 Docker：识别 25 个已加载音色；中性短句返回 103680 字节 PCM，首次读取约 0.42 秒，总耗时约 1.42 秒；错误密钥和来源被拒绝。首次读取是客户端读取统计，不等于手机实际起播延迟。尚未使用真实手机验证。