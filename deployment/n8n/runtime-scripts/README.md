# n8n 外部运行脚本

这里保存 E006（拼多多素材下载）与 E007（1688 素材下载）实际调用的源码。部署程序会把本目录复制到仓库外的 `n8n-runtime/scripts/`，安装锁定依赖后再由全局 n8n 调用。

仓库只保存源码和锁文件，不保存浏览器 Profile、Cookie、下载结果、幂等运行状态或任何授权数据。运行数据统一位于用户的 MerchRoute 外部数据目录。全新部署分别使用 `browser-profiles/pdd` 与 `browser-profiles/1688`，不得共用系统默认 Profile 或彼此复用。

固定运行时：Node.js 22.23.1、npm 10.9.8、Playwright 1.61.1、Sharp 0.34.5。登录脚本只打开本机 Chrome 供用户自行登录，不自动填写账号、不绕过验证码。

`browser-profile-smoke.cjs` 只用离线 `data:` 页面验证两个专用目录可被 Google Chrome + Playwright headless persistent context 打开并关闭；它不访问平台页面、不读取 Cookie 值，也不触发 n8n 工作流。
