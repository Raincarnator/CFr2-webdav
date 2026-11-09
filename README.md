# Cloudflare R2 WebDAV

在 Cloudflare Workers 上运行的单账号 WebDAV 服务。R2 存放文件正文，SQLite Durable Object 保存目录树、文件元数据、自定义属性和锁。目录复制共享文件正文，目录移动、复制、覆盖和删除在 SQLite 事务中更新。

## 支持的操作

| 操作 | 行为 |
| --- | --- |
| `OPTIONS` | 公布 DAV 能力和允许的方法 |
| `GET`、`HEAD`、`PUT` | 流式上传和下载、单段字节范围、ETag 和 HTTP 条件请求 |
| `MKCOL`、`DELETE` | 创建空目录、递归删除 |
| `PROPFIND` | `Depth: 0/1/infinity`，支持 `allprop`、`propname`、指定属性及 `include` |
| `PROPPATCH` | 事务性设置和删除带 XML 命名空间的自定义属性 |
| `COPY`、`MOVE` | 同源文件与目录操作、`Depth`、`Overwrite` 和目标锁检查 |
| `LOCK`、`UNLOCK` | 共享与独占写锁、递归锁、锁刷新和 DAV `If` 条件 |

用 WebDAV 客户端连接部署输出的 HTTPS 根地址。浏览器打开根地址可浏览目录，文件以附件方式下载。认证使用一组 UTF-8 Basic Auth 凭据，用户名不能含冒号，密码可以含冒号。此服务按 [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918.html) 实现核心方法，提供单账号文件服务。ACL、版本管理、CalDAV、CardDAV 和跨域浏览器 API 超出此实现范围。

## 用 Wrangler 部署

1. 安装 Node.js 22.12 或更新版本，推荐 Node.js 24。在 Cloudflare 控制台选择目标账号，进入 **R2 Object Storage** 启用 R2。若控制台要求设置账单资料，先在控制台完成。
2. 在仓库根目录安装依赖、登录并确认账号。

   ```sh
   npm ci
   npx wrangler login
   npx wrangler whoami
   ```

3. 检查 [wrangler.jsonc](wrangler.jsonc)。默认部署到名为 `webdav` 的 Worker；升级现有服务时，名称要与控制台一致。如果已有存放旧 WebDAV 文件的桶，在 `r2_buckets` 的 `BUCKET` 项加上 `"bucket_name": "你的桶名"`，并先阅读下面的迁移说明。新部署可以省略桶名，由 Wrangler 创建并绑定 R2。也可以先用 `npx wrangler r2 bucket create <桶名>` 创建私有桶，再填入桶名。

   SQLite Durable Object 由 Wrangler 按 `migrations` 中的 `v1` 创建。保留 `DAV` 绑定、类名和历史迁移配置。

4. 在根目录创建被 Git 忽略的 `.env.production.json`，写入以下两个字段，并换成实际用户名和唯一的长随机密码。

   ```json
   {
     "USERNAME": "webdav",
     "PASSWORD": "<替换成唯一的长随机密码>"
   }
   ```

   ```sh
   npx wrangler deploy --secrets-file .env.production.json
   ```

   `--secrets-file` 会把凭据和代码一起上传为 Worker Secrets。凭据设置完成后，日常更新使用 `npm run deploy` 即可。需要轮换密码时，可在控制台的 **Settings → Variables and Secrets** 修改 `PASSWORD`，或运行 `npx wrangler secret put PASSWORD`。凭据文件用完后可删除，或保存到密码管理器。配置文件和构建日志都应与凭据分开。

5. 复制部署输出的 HTTPS URL。如果账号还没有 `workers.dev` 子域，在控制台 **Workers & Pages** 设置该子域；有自己的域名时也可以给 Worker 添加 **Custom Domain**。R2 存储桶保持私有。
6. 验证匿名访问返回 `401`，带凭据的根目录查询返回 `207`，且 XML 中根资源是 `/`。

   ```sh
   curl -i https://webdav.<你的子域>.workers.dev/
   curl -i -u webdav -X PROPFIND -H 'Depth: 1' https://webdav.<你的子域>.workers.dev/
   ```

   `curl -u webdav` 会提示输入密码。Windows PowerShell 可用 `curl.exe`。

相关文档见 [Wrangler 资源配置](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)、[Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) 和 [R2 Workers API](https://developers.cloudflare.com/r2/get-started/workers-api/)。

## 通过 Cloudflare 控制台部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Raincarnator/CFr2-webdav)

按钮适合从包含新版配置的 Git 分支创建新实例。需要先登录 Cloudflare、启用 R2，并授权连接 Git 仓库。部署界面可按配置创建和绑定 R2，并执行 Durable Object 迁移。如果界面未提供设置必需 Secrets 的步骤，用上面的 Wrangler 命令完成首次部署。

对于已连接 GitHub 的 Worker，在 **Settings → Builds** 核对生产分支、仓库根目录 `/` 和 Worker 名 `webdav`。使用 Node.js 24，构建命令可设为 `npm run check`，部署命令设为 `npx wrangler deploy`。首次用 Wrangler 上传 Secrets，或在 Worker 设置中配置为 **Secret** 类型。把新版提交推送到该生产分支后，Cloudflare 才会从 Git 构建新版。仓库自带的 GitHub Actions 只执行验证。详见 [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/) 和 [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

## 升级旧版和数据维护

- 升级前备份旧桶，并停止通过旧 Worker、R2 控制台和 S3 API 修改它。在配置里绑定原桶。旧构建流程会打印生成的配置，如果以前配置过生产凭据，升级时请更换密码。
- 第一次认证请求会分批读取旧 R2 键。以 `/` 结尾的旧目录标记和只有文件前缀的隐式目录都会建立索引，现有正文保留在原键上。大桶会暂时返回 `503` 和 `Retry-After`，请继续用带认证的根目录 `PROPFIND` 重试。非法路径键会跳过；若同一路径同时是文件和目录，导入返回 `409`，需要先在备份和原桶中确认并整理冲突键。
- 初始化后，WebDAV 路径以 SQLite 为准。新正文位于桶的 `/.webdav/` 前缀下。通过 WebDAV 管理内容，避免直接写桶、替换绑定、使用同一个桶部署第二个独立实例，或用生命周期规则清除正文。SQLite 索引和 R2 正文应作为一套数据维护，R2 键本身不足以重建新版目录树。
- 取消最后一个文件引用后，后台任务最早约一小时后清理正文。复制后的多个路径可能共享同一个正文。需要可离线恢复的文件备份时，可以通过 WebDAV 导出目录树。Worker 代码回滚不会回滚 SQLite 或 R2 状态。

## 本地开发和限制

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run dev
npm run check
npm test
```

PowerShell 用 `Copy-Item .dev.vars.example .dev.vars` 复制本地凭据。Wrangler 默认用本地 R2 和 Durable Object；测试启动独立的 workerd 实例并预置旧版 R2 数据。

- 单次请求上传上限取决于 Cloudflare 套餐。服务对无 `Content-Length` 的流式上传使用 8 MiB 分片，总量上限 512 MiB。下载支持单段 Range。
- 每个树操作最多处理 10,000 个资源，PROPFIND 还有输出大小限制。XML 请求最多 64 KiB，锁最长一小时。整个命名空间由一个 Durable Object 协调，长上传会占用该命名空间的操作队列。
- 计费由 Cloudflare 分别计算。参见 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[Durable Objects 限制](https://developers.cloudflare.com/durable-objects/platform/limits/) 和 [R2 计费](https://developers.cloudflare.com/r2/pricing/)。
