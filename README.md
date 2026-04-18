# Desktop Reminder

一个基于 `Vue 3 + Pinia + Tauri 2` 的桌面待办悬浮窗应用，rust与前端开发结合的练习作品。

一个运行在 Windows 桌面上的提醒工具：

- 桌面悬浮窗负责展示事项
- 独立编辑窗口负责新增、编辑、样式设置
- 所有数据本地保存，不依赖后端

## 功能概览

- 两个任务分区
  - `With DDL`：带截止时间的事项
  - `No DDL`：不带截止时间的事项
- 自动时间同步
  - 读取本机时间
  - 过期 DDL 事项自动移入缓存区，保留 24 小时后自动删除
- 每周重复事项
  - 可设置固定星期和时间
  - 每周自动生成对应任务
- 悬浮窗样式自定义
  - 背景色
  - 文字颜色
  - 强调色
  - 卡片色
  - 字号缩放
  - 透明度
  - 圆角
- 桌面应用能力
  - 系统托盘常驻
  - 单实例运行
  - 开机自启动
  - 悬浮窗位置和尺寸记忆

## 技术栈

- 前端：`Vue 3`
- 状态管理：`Pinia`
- 构建工具：`Vite`
- 桌面外壳：`Tauri 2`
- 原生插件：
  - `@tauri-apps/plugin-autostart`
  - `@tauri-apps/plugin-window-state`
  - `tauri-plugin-single-instance`

## 项目结构

```text
desktop_reminder/
├─ src/
│  ├─ App.vue
│  ├─ main.ts
│  └─ stores/
│     └─ reminder.ts
├─ src-tauri/
│  ├─ src/
│  │  ├─ lib.rs
│  │  └─ main.rs
│  ├─ tauri.conf.json
│  └─ Cargo.toml
└─ README.md
```

## 本地开发

### 1. 安装依赖

```powershell
npm install
```

### 2. 运行前端网页调试

```powershell
npm run dev
```

这个模式主要用于调样式和前端逻辑，不等同于真正的桌面应用行为。

### 3. 运行桌面开发版

```powershell
npm run tauri:dev
```

这个模式会启动：

- 编辑窗口
- 悬浮窗窗口
- 托盘逻辑

## 下载地址

在[release](https://github.com/cccxyx/Desktop-Reminder/releases)界面直接下载。

## 使用说明

### 桌面悬浮窗

- 显示当前有效事项
- 点击事项可跳转到编辑窗口修改
- 可手动隐藏
- 位置和尺寸会自动保存

### 编辑窗口

- `Tasks`：新增或编辑普通任务
- `Weekly`：新增或编辑每周重复规则
- `Style`：调整悬浮窗样式和开机启动
- `Cache`：查看已归档事项

### 托盘行为

- 关闭窗口不会退出应用
- 应用会缩到系统托盘
- 再次启动应用时会唤醒旧窗口，而不是生成一套新的窗口

## 数据存储

项目不使用后端。

所有数据都保存在本地浏览器/桌面 WebView 的存储中，包括：

- 任务列表
- 每周重复规则
- 缓存区记录
- 悬浮窗样式设置

## 已知说明

- 悬浮窗目前使用 Tauri 普通窗口实现，在 Windows 上更接近“桌面底层便签”，但不是真正嵌入壁纸层的桌面控件。
- 如果系统开启了较严格的代码完整性策略，Rust/Tauri 构建可能会被拦截，需要放行本机构建产物。
- `src/router` 和 `src/stores/counter.ts` 目前不是核心业务所需文件，保留主要是因为项目最初由 Vue 模板生成。

## 常用命令

```powershell
npm run type-check
npm run build
npm run tauri:dev
npm run tauri:build
```
