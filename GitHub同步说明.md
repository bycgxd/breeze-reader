# 两台电脑同步轻声

仓库：https://github.com/bycgxd/breeze-reader （私有）。两台电脑均需安装 Git 与 GitHub CLI，并执行 `gh auth login`、`gh auth setup-git`，使用有仓库权限的账号。不要在 Git URL 或文件中放访问令牌。

## 当前 Windows 电脑

日常酒馆安装目录：`D:\aweb\SillyTavern\data\default-user\extensions\breeze-reader`。
开发源码目录：`D:\BASE\桌面\work\角色卡制作\extensions\breeze-reader`。
两者均连接到本仓库；更新哪个目录，就在那个目录运行：

```sh
git pull --ff-only
```

完成后重新打开酒馆。更新源码目录不会自动更新已安装目录；需要在安装目录也执行一次更新。

## 另一台电脑首次安装

如果已有 breeze-reader 文件夹，先将旧文件夹移到扩展目录外作为备份，再在该电脑实际的酒馆扩展目录执行：

```sh
git clone https://github.com/bycgxd/breeze-reader.git breeze-reader
```

常见路径为 `SillyTavern/data/default-user/extensions`，使用其他账号或 App 时以实际目录为准。之后在克隆出的 breeze-reader 目录运行 `git pull --ff-only` 即可更新。原生 iOS App 自带扩展的安装/刷新流程仍由 App 管理。

## 两边开发后如何同步

开始改代码前先 `git pull --ff-only`。改完并检查后：

```sh
git status
git add -- 需要提交的文件名
git commit -m "说明这次改动"
git push
```

然后另一台电脑 `git pull --ff-only`。如果提示本地修改或分支分叉，先保存并合并改动；不要使用强制推送或强制覆盖。尽量避免两台电脑同时修改同一文件。

## 服务和设置

GitHub 只同步插件文件，不同步模型、音色、音频缓存、聊天记录、连接密钥、人物配音或原生 iOS App 源码。
模型继续在 Windows 上运行。Windows 先打开 Docker Desktop，再运行「启动手机连接.bat」。手机/Mac 在同一局域网内连接 `http://192.168.31.178:8790`，密钥在 Windows 的 `%LOCALAPPDATA%\BreezeReader\手机连接说明.txt` 中查看并手动填写，不要提交。
启动脚本与 Docker 配置包含当前 Windows 的路径和 IP；Mac 客户端不执行这些 Windows 脚本。电脑 IP 变化时须同步调整服务绑定、来源限制与客户端连接地址。
