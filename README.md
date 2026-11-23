# 汪汪队 · 立直对局室

四人立直麻将试玩版，支持 3D 牌桌、好友房、电脑补位、段位和完整半庄回放。

## 下载试玩

从 [Releases](https://github.com/v0okashu/riichi-table/releases/latest) 下载 Windows x64 的单文件 EXE，双击打开牌桌。注册账号并设置昵称后，创建房间并点击「开始半庄」。空位由电脑补齐。

桌面版内置 Node.js，并使用系统的 Microsoft Edge WebView2 Runtime。账号、段位和牌谱保存在当前 Windows 用户的本地应用数据目录 `WangWangRiichi` 中。

## 从源码运行

安装 Node.js 22.18 或更高版本，运行以下命令后打开 http://localhost:8787/ 。

```sh
npm ci
node server.js
```

账号、段位和牌谱默认写入 `data/`。可用环境变量 `RIICHI_DATA_DIR` 指定存储目录。不同设备连接同一台服务器，并用同一账号登录，就能查看记录。

麻将规则引擎与电脑对手使用 Satoshi Kobayashi 的 [majiang-core](https://github.com/kobalab/majiang-core) 与 [majiang-ai](https://github.com/kobalab/majiang-ai)。
