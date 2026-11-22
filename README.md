# Wabicat 信息站

一个轻量的中文信息展示站，用于阅读经过整理的新闻、旅行灵感及其他信息。网页提供标题、摘要、正文、分类、发布时间和来源链接，并支持搜索与分页加载。

## 运行

- Node.js 18 或更新版本；不需要第三方 npm 包。
- 执行 `npm start`（或 `node server.js`）。默认监听 `6688` 端口，可用 `PORT` 修改。
- 配置强随机值 `ADMIN_API_KEY` 后才能启用写接口；不要提交密钥。
- 内容默认保存到 `data/items.json`。如果主机在重新部署时会清理应用目录，请用 `DATA_FILE` 指定持久化路径。
- 执行 `npm test` 运行内置 Node 测试（无需安装依赖）。

## API

公开读取：`GET /api/items`，返回 `{ "items": [...] }`；支持 `q`、`limit`（最多 50）和 `offset` 参数，并返回总数与 `hasMore`。健康检查：`GET /api/health`。

写入路由要求 `Authorization: Bearer $ADMIN_API_KEY`（也支持 `X-Admin-Token`）。JSON 字段：`title`（必填，最多 180 字符）、`summary`（最多 500）、`body`（最多 12,000）、`category`（最多 60）、可选 `sourceUrl`（仅 http/https）。请求体限制为 256 KiB。

- `POST /api/items`：新增信息，成功返回 `201`。
- `PATCH /api/items/:id` 或 `PUT /api/items/:id`：更新提供的字段。
- `DELETE /api/items/:id`：删除指定信息。

示例：

```sh
curl -X POST https://YOUR-HOST/api/items \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"示例资讯","summary":"简短摘要","body":"正文","category":"新闻","sourceUrl":"https://example.com/"}'
```

## 安全与数据

`.env` 和 `.env.*` 被 Git 忽略；只在服务器环境配置 `ADMIN_API_KEY`，不要把密钥写进代码、公开网页、URL 或提交记录。页面响应提供带随机 nonce 的脚本 CSP、安全响应头，并对内容做 HTML 转义；服务端使用恒定时间比较令牌、限制请求体大小、验证 URL 与字段、序列化内容写入，并通过唯一临时文件和重命名保存数据。

内容默认存于 `data/items.json`。若部署平台重新部署会清理应用目录，应将 `DATA_FILE` 指向持久化存储。公开列表设短期缓存；管理响应不缓存。

## 部署记录

该项目原先部署于 Silly Development。其早先 Cloudflare 配置记录指出，`info.wabicat.kdns.fr` 使用 Flexible SSL：访客至 Cloudflare 为 HTTPS，但 Cloudflare 到源站仍为 HTTP。因此不要把它描述为端到端加密，也不要经该明文回源链路传输管理员密钥。部署与 DNS 配置可能变化，操作前应重新核对。
