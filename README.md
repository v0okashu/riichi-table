# 雀庭

四人立直麻将试玩版，含 3D 牌桌、好友房和电脑补位。

## 下载试玩

在仓库的 **Releases** 页面下载 Windows x64 试玩包。完整解压后双击 **Start.cmd**。在浏览器里输入昵称、创建房间，再点击「开始半庄」。空位由电脑补齐。关闭启动窗口即可退出。

试玩包包含 Node.js 运行环境，支持 Windows 10 / 11 x64。下载版在本机运行。

## 从源码运行

使用 Node.js 22，运行以下命令后打开 http://localhost:8787/ 。

```sh
npm ci
node server.js
```

麻将规则引擎与电脑对手使用 Satoshi Kobayashi 的 [majiang-core](https://github.com/kobalab/majiang-core) 与 [majiang-ai](https://github.com/kobalab/majiang-ai)。
