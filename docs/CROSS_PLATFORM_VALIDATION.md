# Cross-platform regression boundary

## What this repair changes

- Personal-memory files are written and synced through a writable, exclusively
  created temporary file, then atomically renamed. Linux also syncs the parent
  directory. Disk errors are propagated, not treated as successful persistence.
- Account metadata keeps file fsync on every platform and directory fsync on
  POSIX. Node does not offer equivalent directory fsync on Windows; this is not
  a claim of identical crash-durability or ACL guarantees across platforms.
- Windows absolute drive paths in explicit host file links are no longer
  mistaken for URI schemes. HTTP/custom schemes and drive-relative paths remain
  excluded. Existing host/tenant routing and ownership boundaries are unchanged.
- SQLite fixtures close databases before removing their temporary directories.
  App Server fixtures allow bounded retries while Windows releases child-process
  working-directory handles. Functional assertions are retained.
- Source/script line endings are declared in `.gitattributes`; affected source
  assertions accept either LF or CRLF. No global Git configuration is changed.
- Test CLI fixtures run through Node explicitly; bridge fixtures use a Windows
  named pipe where a Unix socket is unavailable.

## Platform-specific checks are not passing checks

The Windows suite reports explicit skips for the following unavailable features:

| Check | Required verification |
|---|---|
| Three POSIX permission assertions | Linux mode bits; Windows ACLs need separate validation |
| Three symlink rejection subtests | Real symlinks; Windows skips only EPERM, never other errors |
| Deployment coordinator | Linux root, Bash, Python and real flock |
| Conversation, reader and voice cold-storage round trips | Linux GNU tar and executable CLI fixtures |
| Directory fsync error propagation | POSIX directory handles |
| Existing tenant UID ownership check | Linux root and distinct tenant UID |

Shared-auth lease/account tests additionally require `flock`. They run on Windows
when it is installed, otherwise are explicitly skipped; Linux never skips them
for a missing executable. Locks are not stubbed out. Cold-storage fixtures test
local round-trip orchestration, not a live cloud provider or real encryption keys.

The CI matrix runs `npm run verify` on Windows and Linux, using Node 22 and 24.
Linux runs with root privileges in the disposable runner so tenant UID and
deployment checks execute. `REQUIRE_SYMLINK_TESTS=1` makes symlink creation errors
fatal there. These checks remain outstanding acceptance requirements; merely
adding the workflow does not mean CI ran or passed.

## Recorded validation and remaining acceptance

Local repair validation (2026-09-21, Windows, Node 24.11.0):

- `npm run verify`: passed, including TypeScript checks and both builds.
- Application: 350 tests, 338 passed, 0 failed, 12 explicitly skipped as listed above.
- Remote Worker: 54 tests, 54 passed, 0 failed, 0 skipped; PowerShell syntax checks passed.
- Of the original 35 failing parent tests, 31 now pass and 4 Linux integration
  tests remain unverified locally. Six passing parents contain an explicitly
  skipped POSIX-permission or symlink subtest; those assertions are not certified.
- Linux and Node 22 matrix jobs have not run locally. No production deployment
  or manual mobile validation was performed as part of this compatibility repair.

1. Run `npm run verify` in the repair checkout and inspect both failures and skips.
2. Obtain passing Linux CI results, especially persistence, ownership, cold
   storage and deployment coordinator checks. Do not use production as a test rig.
3. Review the accumulated feature history separately for confidential data and
   security-sensitive changes. This compatibility repair is not a security
   certification of the entire branch.
4. Validate migration/rollback, persisted queues and attachments, authentication,
   tenant isolation and mobile voice behavior in a staging environment.

Do not publish local diagnostic logs, real credentials, production configuration,
or runtime data along with these source changes.

## main 合入交接：尚未验证的项目（2026-09-21）

本次按维护者明确要求，先合入 main，后续切换 Mac 环境继续验证。
这只是接受带有下列验证缺口的代码合入，不代表全部测试通过，也不授权生产部署。
合入范围包含此前领先 main 的 48 个提交，以及本次跨平台修复和交接文档。

### Windows 本轮跳过的 12 项

| # | 测试名称 | 待验证内容 / 所需环境 |
|---|---|---|
| 1 | preserves executable permission on shared skills | Skill 可执行权限；Mac 或 Linux POSIX 文件系统 |
| 2 | shared Codex auth creates a missing target directory as the tenant identity | 创建认证目录时的租户 UID/属主隔离；优先隔离 Linux root 环境 |
| 3 | account credentials retain private POSIX permissions | 账号凭据文件 0600；Mac 或 Linux |
| 4 | rejects symlinked tenant project directories | 拒绝符号链接项目目录；Mac 或 Linux |
| 5 | does not read personal context through a symlink | 不通过符号链接读取个人记忆；Mac 或 Linux |
| 6 | event credentials retain private POSIX permissions | 事件凭据目录 0700、文件 0600；Mac 或 Linux |
| 7 | persisted rebuild coordinator records conflict queue progress and pauses terminal failures | 部署冲突、排队进度与失败暂停；Linux root、Bash、Python、flock |
| 8 | archived conversations bypass inactivity and round-trip every unshared registered file | 会话及附件归档恢复完整性；Linux、GNU tar、可执行测试 CLI |
| 9 | directory fsync errors remain visible on POSIX and release the descriptor | 目录同步错误传播及句柄释放；Mac 或 Linux |
| 10 | rejects a symlinked skills directory | 拒绝符号链接 Skill 目录；Mac 或 Linux |
| 11 | reader normalized resources round-trip through the encrypted cold-storage boundary | 阅读器资源冷存储往返；Linux、GNU tar、可执行测试 CLI |
| 12 | voice audio persists with ownership metadata and round-trips through encrypted cold storage | 音频及所属元数据冷存储往返；Linux、可执行测试 CLI |

其中第 7、8、11、12 项是原 35 个失败主测试中尚未在目标环境验证的 4 项。
另外 31 个主测试在 Windows 通过，但其中 6 个含上表中跳过的权限/符号链接子测试，
不能把主测试通过等同于这些安全断言也通过。

### 在 Mac 上接续

1. 使用干净的 main checkout，确认包含本交接文档；不要覆盖已有未提交修改。
2. 重新安装 Mac 对应的依赖，不复制 Windows 的 node_modules：

   ```sh
   npm ci
   npm ci --prefix remote-worker
   npm run verify
   ```

3. 先使用 Node 24，再验证 Node 22；每次记录版本、提交 SHA、通过/失败/跳过数量及原因。
   Windows 已验证版本是 Node 24.11.0；这不是 Mac/Node 22 已通过的证据。
4. Mac 可补测 POSIX 权限、符号链接和目录同步。共享认证测试需要真实的 flock，
   系统缺少该命令时应记录环境前置条件，不能替换为空操作。
5. 第 7、8、11、12 项由测试明确限定 Linux，在 Mac 原生运行仍会跳过；
   应使用隔离 Linux 容器/虚拟机或本仓库 Linux CI。不要在 Mac 主机或生产服务器
   上使用 sudo 强行执行 Linux 部署测试。Linux UID 隔离也应在隔离 Linux root 环境验证。

### 仍需完成的整体验收

- GitHub CI 的 Linux/Windows × Node 22/24 结果需另行确认；配置存在不等于通过。
- 本次修复版本的手机录音、保存音频重试、上传恢复尚未进行人工回归。
- 测试环境中的数据库迁移/回滚、队列及旧附件持久化、登录和租户隔离验收仍未完成。
- 冷存储测试使用模拟 CLI，不证明真实云端存储或真实加密配置可用。
- 累计 48 个提交尚未完成全面安全审计；基础敏感信息检查不构成安全认证。
- 不携带生产密钥、真实用户数据或服务器专用配置进入测试环境或公开提交。
