# Vercel API Proxy

[English README](./README_EN.md)

基于 Vercel 的免费反向代理：在任意 URL 前加个前缀，就能通过你的域名访问它。适合给 OpenAI 等 API 换入口域名、加速 GitHub 访问与下载等场景。

## 功能特性

- **完全免费** —— 跑在 Vercel 免费版上（每月 100GB 流量）
- **零依赖** —— 一个静态首页 + `vercel.json` 重写规则 + 一个 Edge Function，无构建步骤
- **两种代理模式** —— 直转（rewrite）与增强（Edge Function：跟随 3xx 跳转、自带 CORS）
- **自动深浅色首页** —— 输入 URL 即可同时生成两种模式的代理链接

## 部署

**方式一：一键部署（推荐）**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/TrueHOOHA/vercel-api-proxy)

**方式二：手动部署**

1. Fork 本仓库
2. 登录 [Vercel](https://vercel.com/)，**New Project** → 选择你 Fork 的仓库 → **Deploy**

   ![新建项目](assets/newproject.png)

3. （可选，推荐）绑定自定义域名：`.vercel.app` 子域在国内可能访问不稳定。在你自己的域名服务商处添加 CNAME 记录，指向 Vercel 给出的地址即可。

   ![绑定域名](assets/domain.png)

## 使用方法

在任意 URL 前加上前缀即可：

```
https://你的域名/https/目标URL            ← 直转模式
https://你的域名/http/目标URL
https://你的域名/api/proxy/https/目标URL   ← 增强模式
```

| 前缀 | 映射到 |
|------|--------|
| `/https/目标URL` | `https://目标URL` |
| `/http/目标URL` | `http://目标URL` |
| `/api/proxy/https/目标URL` | `https://目标URL`（增强模式） |
| `/api/proxy/http/目标URL` | `http://目标URL`（增强模式） |

### 两种模式怎么选

| 场景 | 用哪个 |
|------|--------|
| 服务器端调用 API、大文件下载 | 直转 `/https/...`：无函数开销、保留 `Content-Length` |
| 目标站会 3xx 跳转、浏览器网页里直接 `fetch` | 增强 `/api/proxy/...`：`Location` 重写回代理格式（跳转不断链）；响应带 `Access-Control-Allow-Origin: *` |

> 增强模式会把请求体整体读入内存、去掉 `Content-Length`，并受函数执行时长限制——大文件下载请走直转模式。它也不改写页面里的静态资源引用。

### 首页

部署后访问你的域名，输入完整 URL（带 `http://` 或 `https://` 前缀），会同时生成两种模式的链接，可一键复制或直接打开。

## 示例

### 1. 给 OpenAI API 换入口

```python
openai.api_base = "https://你的域名/https/api.openai.com/v1"
```

### 2. GitHub 加速

```text
https://github.com/TrueHOOHA/vercel-api-proxy
→ https://你的域名/https/github.com/TrueHOOHA/vercel-api-proxy
```

Release 下载（`github.com` 会 302 到 `objects.githubusercontent.com`）：

- 直转模式：直接代理 302 后的最终地址 `https://你的域名/https/objects.githubusercontent.com/...`
- 增强模式：直接代理原始链接即可，跳转自动跟随：
  `https://你的域名/api/proxy/https/github.com/owner/repo/releases/download/v1.0/file.zip`

### 3. Google 搜索（网页代理的局限）

```text
https://www.google.com/search?q=vercel-api-proxy
→ https://你的域名/https/www.google.com/search?q=vercel-api-proxy
```

> 网页代理只适合简单、纯文本的页面。HTML 里引用的静态资源（`/js/x.js` 等）不会被改写，复杂页面会错乱——两种模式都一样。

## 工作原理

- **直转模式**：`vercel.json` 里的 4 条 rewrite 规则，把路径里的协议段还原后转发，无任何函数开销
- **增强模式**：`api/proxy/[...path].ts`（Edge Function）转发请求，用 `redirect: 'manual'` 拿到 3xx 并把 `Location` 重写回代理格式，同时给响应补 CORS 头
- 首页是单文件 `index.html`，仅做链接生成

## 注意事项

1. **流量限制** —— Vercel 免费版每月 100GB，请合理使用
2. **静态资源** —— 代理网页时，页面内引用的资源路径不会被改写（见示例 3）
3. **合规使用** —— 请遵守当地法律法规与 Vercel 服务条款，仅用于合法用途

## 致谢

Fork 自 [souying/vercel-api-proxy](https://github.com/souying/vercel-api-proxy)，在此基础上有以下改动：

- 修复首页 URL 截断 bug（`split(':/')` 会丢弃第二个 `":/"` 之后的内容）
- 移除从未生效的 WSS 规则，以及会把任意路径改写成非法协议的 `:protocol*` 兜底规则
- 新增增强模式（Edge Function：3xx 跳转跟随 + CORS）
- 首页重设计（Vercel 风格、自动深浅色、双链接同时生成）

## 许可证

仅限学习研究使用。
