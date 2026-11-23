# 汪汪队 · 立直对局室

四人立直麻将试玩版，支持局域网组网联机、3D 牌桌、电脑补位、段位和完整半庄回放。

## 下载试玩

从 [Releases](https://github.com/v0okashu/riichi-table/releases/latest) 下载 Windows x64 的单文件 EXE，双击打开牌桌。注册账号并设置昵称后，创建房间并点击「开始半庄」。空位由电脑补齐。

本地试玩版内置 Node.js，并使用系统的 Microsoft Edge WebView2 Runtime。账号、段位和牌谱保存在当前 Windows 用户的本地应用数据目录 `WangWangRiichi` 中。

## 局域网组网联机

1. 所有玩家先加入同一个可互访的蒲公英或其他局域网组网，然后打开 EXE 登录。
2. 房主在大厅点「创建房间」，选择组网网卡，用音效键旁的「复制房间号」分享房间。
3. 朋友在大厅输入房间号。首次连接该房主时，在房主服务器登录或注册后即可入座。

组网房间号由 9 位字母和数字组成，分隔符可省略。创建房间时可打开「组网帮助」。

房主需要保持组网和游戏在线。后台只监听房主选中的 IPv4 地址，使用 TCP 8787。该房主的组网账号、排行榜和牌谱保存在 `WangWangRiichi/network-host` 中。

## 部署共享服务器

在一台带公网地址的云服务器上安装 Docker 和 Docker Compose，将游戏域名解析到该服务器，并开放 TCP 80 和 443 端口。把源码放到服务器上，在项目目录执行以下命令，将示例域名替换为实际域名。

```sh
RIICHI_DOMAIN=mahjong.example.com docker compose up -d --build
```

Caddy 会为域名申请并续签 HTTPS 证书。所有玩家使用同一个 HTTPS 地址注册、登录和加入房间。账号、排行榜积分及完整半庄牌谱保存在 `game-data` 卷中。升级时保留该卷，只运行一个 `game` 实例。当前房间和进行中的牌局保存在内存里，服务重启时会结束。

在 Windows 上用相同地址构建单文件联机版。发给玩家后，他们双击即可直接打开同一个服务器。

```powershell
./desktop/build.ps1 -Output ./wangwang-online.exe -ServerUrl https://mahjong.example.com
```

联机版使用服务器的账号数据。本地试玩版里已有的账号和记录需要单独迁移。

## 从源码运行

安装 Node.js 22.18 或更高版本，运行以下命令后打开 http://localhost:8787/ 。

```sh
npm ci
node server.js
```

账号、段位和牌谱默认写入 `data/`。可用环境变量 `RIICHI_DATA_DIR` 指定存储目录。不同设备连接同一台服务器，并用同一账号登录，就能查看记录。

麻将规则引擎与电脑对手使用 Satoshi Kobayashi 的 [majiang-core](https://github.com/kobalab/majiang-core) 与 [majiang-ai](https://github.com/kobalab/majiang-ai)。
