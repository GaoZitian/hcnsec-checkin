# hcnsec daily check-in

GitHub Actions 工作流，用于自动签到 **[https://api.hcnsec.cn/】**（[NewAPI](https://api.hcnsec.cn/) 标准站点）。

## ✨ 功能

- **自动登录**：使用 GitHub Secrets 中的账号密码（仅首次运行或 Cookie 过期时）
- **状态持久化**：登录成功后自动保存浏览器会话（Cookie + localStorage），供下次使用
- **定时签到**：每天北京时间 09:10（UTC 01:10）自动运行
- **结果通知**：签到成功/已签到/失败的日志输出
- **无需手动抓包**：全程自动化，不需要你手动抓取 Cookie

## 📋 前置要求

- GitHub 账号
- hcnsec 网站的登录用户名和密码
- GitHub 仓库（本项目已准备就绪）

## 🔐 配置 GitHub Secrets

进入你的仓库：`Settings → Secrets and variables → Actions → New repository secret`，添加以下 **两个** Secret：

| Secret 名称 | 值 |
| --- | --- |
| `HCNSEC_USERNAME` | 你的 hcnsec 登录用户名 |
| `HCNSEC_PASSWORD` | 你的 hcnsec 登录密码 |

> **提示**：如果你知道 `new-api-user` 的值，也可以添加第三个 Secret `HCNSEC_NEW_API_USER`；未填写脚本会在登录后自动探测。

## 🚀 快速开始

### 1. 部署项目（推荐：Fork 本仓库）

**最简单的方式**是直接 Fork（复制）这个仓库到你的 GitHub 账号下：

1. 访问：`https://github.com/GaoZitian/hcnsec-checkin`
2. 点击右上角 **Fork** 按钮，将仓库复制到你的个人空间
3. Fork 后，进入你的仓库：`Settings → Secrets and variables → Actions → New repository secret`
4. 添加两个 Secret（同前面配置部分）：
    - `HCNSEC_USERNAME`：你的用户名
    - `HCNSEC_PASSWORD`：你的密码
5. 完成！GitHub Actions 会自动检测并运行定时任务

> **为什么推荐 Fork？**
>
> - 工作流已经预配置好，无需手动创建文件结构
> - Secrets 设置会随仓库一起复制过去
> - 你可以随意修改工作流或脚本，而不影响原仓库

### 2. 手动首次触发

1. 进入 GitHub 仓库的 **Actions** 选项卡
2. 选择 "hcnsec daily check-in" 工作流
3. 点击右上角 **Run workflow** 按钮手动启动

**首次运行会自动**：

- 用你的账号密码登录 hcnsec 网站
- 保存登录状态 (`storageState.json`，包含有效 Cookie)
- 完成第一次签到
- 在日志中输出签到结果

### 3. 以后的使用

- **定时执行**：工作流配置为每天北京时间 09:10 (UTC 01:10) 自动运行
- **手动执行**：随时可以点击 **Run workflow** 手动触发
- **查看结果**：Actions 页面会显示每次签到的成功/失败/已签到状态
- **Cookie 过期**：如果某天签到失败（通常提示 `AUTH_UNAUTHORIZED`），可能是 Cookie 已过期（30-90 天一次），重新运行一次 `Run workflow` 即可重新登录保存新状态

## 📁 项目结构

```
hcnsec-checkin/
├── .github/workflows/daily-checkin.yml    # GitHub Action 工作流配置
├── src/
│   ├── checkin.js                         # 核心脚本（Playwright 登录 + 签到 + 状态持久化）
│   └── package.json                       # 依赖配置（playwright + node-fetch）
└── README.md                              # 本文件
```

## ⚙️ 工作流配置

`.github/workflows/daily-checkin.yml` 包含：

- **定时触发**：`cron: '10 1 * * *'`（每天 UTC 01:10，北京时间 09:10）
- **工作节点**：`ubuntu-latest`
- **环境变量**：自动从 GitHub Secrets 注入 `HCNSEC_USERNAME` / `HCNSEC_PASSWORD`
- **主要步骤**：
    1. 检出代码
    2. 设置 Node.js 20
    3. 安装依赖 (`npm ci`)
    4. 安装 Playwright 浏览器
    5. 运行签到脚本

## 🔒 安全说明

- **明文密码**：仅在 GitHub Actions 临时运行的容器中使用，不会永久存储或上传
- **数据隐私**：所有凭证均在 GitHub runner 环境内处理，不涉及第三方服务
- **可撤销**：任何时候可以删除 Secrets 或 `storageState.json`，重新运行脚本生成新状态
- **最小权限**：Workflow 只需要读写权限，不涉及其他仓库资源

## ❓ 常见问题

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `AUTH_UNAUTHORIZED` / 401 | Cookie 过期或账号密码错误 | 重新运行 `Run workflow` 重新登录 |
| `今日已签到` | 当天已执行过签到 | 正常现象，日志会标记为 `already` |
| 网络超时 | GitHub IP 被目标站屏蔽 | 稍后重试或检查网络设置 |
| 签到失败 | 站点维护或参数变动 | 重新运行 `Run workflow` 重新登录 |

## 📄 许可证

MIT License - 免费使用，修改请保留版权声明。

## 💬 联系方式

如有问题或建议，请在 GitHub 仓库中提 Issue。