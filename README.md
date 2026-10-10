# hcnsec 每日签到 GitHub Action

## 项目说明

本项目实现了 **hcnsec (https://api.hcnsec.cn/)** 的每日自动签到，基于 NewAPI 标准，无需手动抓包，账号密码安全存储在 GitHub Secrets 中。

## 工作原理

1. **首次运行**：GitHub Actions 使用 `HCNSEC_USERNAME` / `HCNSEC_PASSWORD` 登录网站
2. **保存状态**：登录成功后，自动保存浏览器 `storageState.json`（包含有效 Cookie + localStorage）
3. **后续运行**：每天定时自动读取已保存的登录态，直接使用有效 Cookie 签到
4. **Cookie 过期**：大多数站 30-90 天一次，过期后重新运行 `Run workflow` 即可重新登录保存新状态

## 目录结构

```
hcnsec-checkin/
├── .github/workflows/daily-checkin.yml    # GitHub Action 工作流
├── src/
│   ├── checkin.js                         # 核心脚本（Playwright 登录 + 签点 + 状态持久化）
│   └── package.json                       # 依赖配置
└── README.md                              # 本文件
```

## 快速开始

### 1. 环境准备

确保你有一个 GitHub 账号，并登录。

### 2. 添加 GitHub Secrets

进入你的仓库：`Settings → Secrets and variables → Actions → New repository secret`，添加以下两个 Secret：

| Secret 名称 | 值 |
|------------|-----|
| `HCNSEC_USERNAME` | 你的 hcnsec 登录用户名 |
| `HCNSEC_PASSWORD` | 你的 hcnsec 登录密码 |

> **提示**：如果你知道 `new-api-user` 的值，也可以添加 `HCNSEC_NEW_API_USER`；未填写脚本会自动在登录后探测。

### 3. 部署项目

```bash
# 如果你还没有仓库，可先在 GitHub 创建一个名为 hcnsec-checkin 的新仓库
cd /path/to/local/folder
# 将本项目克隆或下载到本地
git init
git add .
git commit -m "init: hcnsec daily checkin"
git remote add origin https://github.com/<你的用户名>/hcnsec-checkin.git
git push -u origin main
```

### 4. 手动首次触发

1. 进入 GitHub 仓库的 **Actions** 选项卡
2. 选择 "hcnsec daily check-in" 工作流
3. 点击右上角 **Run workflow** 按钮手动启动

**首次运行会自动**：
- 用你的账号密码登录
- 保存登录状态 (`storageState.json`)
- 完成第一次签到
- 在日志中输出签到结果

### 5. 以后的使用

- **定时执行**：工作流配置为每天北京时间 09:10 (UTC 01:10) 自动运行
- **手动执行**：随时可以点击 **Run workflow** 手动触发
- **查看结果**：Actions 页面会显示每次签到的成功/失败/已签到状态
- **Cookie 过期**：如果某天签到失败，可能是 Cookie 已过期，重新运行一次 `Run workflow` 即可重新登录

## 脚本功能

`checkin.js` 的核心逻辑：

1. **尝试恢复已保存的登录态** - 如果有 `storageState.json`，直接使用有效 Cookie 签到
2. **自动登录** - 如果没有保存的态或已过期，使用 GitHub Secrets 中的 `HCNSEC_USERNAME` / `HCNSEC_PASSWORD` 自动登录
3. **处理人机验证** - 如果登录页有验证码，脚本会暂停等待（GitHub Actions 环境下通常无此问题）
4. **保存状态** - 登录成功后自动保存 `storageState.json`，供下次使用
5. **执行签到** - 使用保持有效会话的 Cookie 调用 `/api/user/checkin` 端点
6. **结果输出** - 打印签到成功/已签到/失败的详细信息

## 工作流配置

`.github/workflows/daily-checkin.yml` 包含：

- **定时触发**：`cron: '10 1 * * *'`（每天 UTC 01:10，北京时间 09:10）
- **工作节点**：`ubuntu-latest`
- **环境变量**：自动从 GitHub Secrets 注入
- **步骤**：
  - 检出代码
  - 设置 Node.js 20
  - 安装依赖 (`npm ci`)
  - 安装 Playwright 浏览器
  - 运行签到脚本

## 安全说明

- **明文密码**：仅在 GitHub Actions 临时运行的容器中使用，不会永久存储
- **数据隐私**：所有凭证均在 GitHub runner 环境内处理，不上传第三方服务
- **可撤销**：任何时候可以删除 Secrets 或 `storageState.json`，重新运行脚本生成新状态
- **最小权限**：Workflow 只需要 `read` 和 `write` 权限，不涉及其他仓库资源

## 常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| `AUTH_UNAUTHORIZED` / 401 | Cookie 过期或账号密码错误 | 重新运行 `Run workflow` 重新登录 |
| `今日已签到` | 当天已执行过签到 | 正常现象，日志会标记为 `already` |
| 网络超时 | GitHub IP 被目标站屏蔽 | 稍后重试或检查网络设置 |
| 签到失败 | 站点维护或参数变动 | 重新运行 `Run workflow` 重新登录 |

## 许可

MIT License - 免费使用，修改请保留版权声明。

## 联系方式

如有问题或建议，请在 GitHub 仓库中提 Issue。