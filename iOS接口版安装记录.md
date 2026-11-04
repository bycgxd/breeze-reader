# iOS 接口版安装记录

更新来源：用户提供的「轻声-iOS接口版-1.7.0-ios.1.zip」。仅采用其中变化的 cache.mjs、index.js、interaction.mjs、stream-player.mjs、manifest.json 及新增 ios-platform.mjs；忽略 Mac 的 ._ 资源附属文件。其余模型、Docker 配置、桥接、音色、角色绑定和连接设置保留现有版本。

新增模块仅在配套 App 注入 __nativeIOSReader.version===1 时启用，提供 begin/commit、缓存分块交换、原生控件与选区转交；普通浏览器继续使用网页播放器。这个包不包含提供原生播放能力的 iOS App 本体。

新增 ios-platform.test.mjs 验证普通浏览器回退、原生缓存读写、分块上传与回存、播放状态、控制命令及停止后忽略迟到消息/取消准备。其余 Node 连接、启动、文本、PCM 和缓存检查通过。真实 iOS App、锁屏和后台播放需要在配套 App 中另行验证。

安装前已备份工作区和酒馆内插件，路径记录在 output/breeze-tts-integration/ios-update-backup-path.txt。本次仅更新轻声插件文件，不改酒馆设置、其他脚本或正则。刷新酒馆或重新打开配套 App 中的酒馆页面后加载新版。
浏览器回归结果：隔离 24 项、多角色配音 36 项、缓存与连接 27 项、正文交互 42 项全部通过，共 129 项。
