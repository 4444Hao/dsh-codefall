# dsh-codefall — 工程日志与实测记录

> 这是本插件的**内部工程文档**：环境事实、官方扩展点契约、逐项实测证据、以及踩过的坑。
> 面向使用者的说明在 [README.md](../README.md)。
>
> 它按时间累积，因此读起来像日志而不是手册——**这正是它有价值的地方**：第 1、2 节记录的是在
> `0.2.0-rc.2` 上逐条核实过的结论，第 9 节记录了一次真实事故与回退。凡是"实测"字样，都指
> 在真实运行的应用上验证过，而不是从名字推断的。

---

## 0. 本版相对上一版的变化

| 项 | 上一版 | 本版（已实测） |
| --- | --- | --- |
| 名字 | dsh-matrix-rain | **dsh-codefall**（`matrix` 在这个生态里已被"Matrix 协议 IM 桥接"占据，见 5.4） |
| 宿主版本 | 未知 | **dsh 0.2.0-rc.2**，桌面壳 `@deepseek-ai/dsh-desktop` 0.2.0-rc.2 |
| profile | 未知 | **desktop**（非 web），`mode: compatibility`，GUI 由 HTTP 回环服务 |
| 启动注入机制 | "待确认" | **`webserver/index-inject` 结构化行 + `tapIndex` 逃生口**（已读到官方实现） |
| 主题机制 | "优先使用 ctx.theme" | **`ctx.theme.overrideTokens` 已确认**，且确认它才是唯一有效杠杆（官方用 body 内联样式写 token） |
| 设置持久化 | "注册设置与预览" | **官方白名单不开放第三方命名空间**，必须自建 host 路由 + 自落盘 |
| 就绪信号 | "待确认" | **官方没有公开就绪信号**，改用客户端首挂载 + 看门狗 |
| 首帧防闪 | "配色提前应用" | 确认可行，且确认首帧底色**必须贴合官方 dark `#151517`** |
| 浅色模式 | 未提 | **是必须设计的分支**（我们的雨天生是深底） |
| 开发方式 | 未定 | 纯桌面端；仓库 `link:` 进 desktop profile（见 6.2） |

---

## 1. 已实测的环境事实

| 事实 | 值 | 证据来源 |
| --- | --- | --- |
| 桌面壳 | `@deepseek-ai/dsh-desktop` **0.2.0-rc.2**，build commit `04f392c9ddd144fa426da2045178797da6db6c11`，Electron 44 | 从 `app.asar` 读出的根 `package.json` |
| 内置运行时 | `@deepseek-ai/dsh-desktop-runtime` **0.2.0-rc.2**，全部官方包同版本 | 同上（`dsh/package.json`） |
| `DSH_HOME` | `$DSH_HOME` | 环境变量 |
| `DSH_PROFILE` | **desktop** | 环境变量 |
| `DSH_PROFILE_DIR` | `$DSH_HOME/profiles/desktop` | 环境变量 |
| GUI | `http://127.0.0.1:19387`，Electron 进程 LISTEN，浏览器访问 | `DSH_WEB_URL` + `netstat` |
| desktop profile 配置 | `mode: compatibility`、`openBrowser: true`、`networkExposure: loopback` | `profiles/desktop\cordis.patch.yml` + `%APPDATA%\DSH Desktop\profile-preferences\…` |
| desktop profile 第三方插件 | **没有任何一个**（`dependencies` 为 `{}`，bundles 只有 `dsh-base` + `dsh-web-app`） | `profiles/desktop\package.json` |
| desktop profile 能否用 CLI 管 | **不能**：`dsh --profile desktop --dump-config` → `error: profile "desktop" is managed exclusively by the Electron application` | 实跑 |
| 应用内商店 | 存在，日志出现 `[dsh-market]`，`desktop-market/state.json` 记 `requested: "dsh-market"` | `%APPDATA%\DSH Desktop\logs\host\…`、`…\desktop-market\state.json` |
| profile 检查点 | 桌面壳会做 "healthy profile configuration checkpoint"，曾报 `backup is incomplete: cordis.patch.yml` | 同上日志 |
| 壳自身冷启动 | 到 renderer ready 约 10.5 s（2026-09-28，桌面 2.0.15 的历史观测） | `…\lifecycle-events\startup.jsonl` |
| ⚠️ 版本错位 | `profiles\node_modules` 里的官方包是 **0.1.0-rc.6**（全局 npm 版 dsh CLI 带来），与运行时 0.2.0-rc.2 不同代 | 读 `package.json` |
| 前端产物 | `dsh-web-frontend/dist/index.html` 极简：只有 `<div id="root">` + `<head>` 里 defer 的 module script，**无任何静态 boot payload** | 从 `app.asar` 读出 |

> 读 `app.asar` 的工具：`tools/extract-app-assets.mjs`（`-List` / `-Read` / `-Save` / `-Grep`）。系统提示里的 checkout 路径不是真实目录，官方源码只存在于 asar 内，后续所有 API 核对都靠它。

### 1.1 两个界面，两条注入通道（实测结论）

**这一节曾写错过两次**，教训是：不要从"GUI 在 19387"推断"桌面窗口走 HTTP"。下面每条都有代码或运行时证据。

| | **Web 版**（`dsh web` / 浏览器） | **桌面端**（你在用的） |
| --- | --- | --- |
| 页面地址 | `http://127.0.0.1:19387/` | **`dsh-app://app/`** —— 实证：桌面窗口的 localStorage origin 就是它 |
| 页面来源 | harness webserver 的 `frontend-static` → **`renderIndex()` 每次请求改写 HTML** | **桌面壳从 app.asar 直读 `dsh-web-frontend/dist`**（`main.js` 11546 `serveWebDocument`），HTML 不归插件管 |
| 注入如何送达 | `webserver/index-inject` 行内联进 HTML | **Host 启动时上报 `injections`，壳经 IPC 交给页面**（`main.js` 11331–11332 / `DESKTOP_IPC.boot` 11560–11567） |
| 页面如何应用 | 已经在 HTML 里 | SPA 的 `hM()` 逐行应用（bundle 偏移 ~631892） |
| 支持的行类型 | 全部 | `global` / `script`(内联 text) / `script-src`(URL) / `script-preload` / `style`(内联 text) / `html` |

**关键结论**：我们发的 `{kind:'script', placement:'body', text}` 正是桌面端 `hM()` 显式支持的类型 ⇒ **同一个包同时适配两种形态**，不需要写两个插件。

**但有个代价必须记住**：桌面端的 `injections` 是 **Host 启动时一次性上报并被壳缓存的**（`injections = ready.injections`）。

> ⇒ **桌面端改动画必须重启应用；Web 版刷新页面即可。**（早期版本曾错误声称"两边都只需刷新"。）

另有一个**启动时序风险**：第三方包经 junction 从磁盘加载，天然比内置行慢；若 Host 采集 `injections` 时我们的行还没激活，桌面端会**静默地**永远拿不到脚本。缓解措施是双路冗余——host 半边注入（Web 版必到、桌面版尽量到）+ client 半边兜底（客户端 bundle 经 `/plugins/*` 转发，桌面窗口必定加载）。当前已实现前者，后者待补。

### 1.2 结论：操作方式的变化

写入 profile 属于高风险操作：装插件前必须备份 `package.json` 与 `cordis.patch.yml`，并单独确认恢复路径。

---

## 2. 官方扩展点契约（0.2.0-rc.2 已核实部分）

### 2.1 首帧注入（本项目的地基）

`dsh-client-ui-theme/lib/index.js`（0.2.0-rc.2）的完整实现就是这个模式：

```js
export const Config = z.object({
  preference: z.union(["light","dark","system"]).default("system").volatile(),
  fontSize: z.number().step(1).min(10).max(22).default(14).volatile(),
});
export function apply(ctx, config) {
  ctx.on("webserver/index-inject", (table) => {
    table.push(...bootThemeInjections(config.preference.get(), config.fontSize.get()));
  }, { prepend: true });
}
```

- 注入行：`{kind:"style", text}` → `<head>`，**在任何脚本执行前给画布上色**；`{kind:"script", placement:"body", text}` → `<body>`；另有 `{kind:"script-preload"}`。
- 官方 webserver README 明确：`renderIndex` 先渲染注入表，再按注册顺序应用原始 `tapIndex(transform)`（逃生口，仍存在）。
- **为什么首帧抢得到**：`dist/index.html` 里的 SPA 是 `<script type="module">`，天然 defer；我们注入的 body classic script 必然先执行。
- ⚠️ `apply(ctx, config)` 收到的是 **live config 访问器**（`config.x.get()`）+ `.volatile()` 字段，这是 0.2.0 的形态，照抄 0.1.x 例子会踩坑。
- 官方自留位：`--dsh-boot-bg`、`document.documentElement.dataset.dsThemeSource`。**不要占用**。
- 官方首帧底色：light = `#fff`，dark = `#151517`（`bootThemeStyle`，一手读到）。

### 2.2 客户端半边

- `window.__ModuleLoader__.load({ id, factory })` —— **已在 0.2.0-rc.2 的 `dsh-client-ui-theme/lib/client.js` 里一手确认**（`factory: (require) => {...}`）。
- 只有 `apply()` 里才做启动动作；bundle 执行只注册工厂。
- 已确认可用的客户端 API：`ctx.provide("theme", theme)`、`ctx.slots.inject(name, () => ctx.slots.register({name, id, order, store, locale}, Component))`、`ctx.locale.register(NS, {zh, en})`、`ctx.theme.overrideTokens(source, tokens)`、`theme.register({id, colorScheme, tokens})`（id 为 `"system"` 会抛错，因为它是偏好不是主题）。
- **设置项 slot 实测用 `settings.general.item`**（ui-theme 自己就用它，`id: "appearance"`，带 `store`）；`settings.section` 是分区级 slot，按需选择。
- 生命周期一律 `ctx.effect(...)`，释放要幂等。
- ⚠️ 客户端 bundle 的服务路由（0.1.x 观测为 `/plugins/<id>/client.js?rev=`）**待阶段 B 复核**。

### 2.3 包结构（双半插件）

`exports["."]` = host 半边，`exports["./client"]` = 浏览器半边；`dsh.bundle.patch` = `cordis.patch.yml`；`dsh.client.{platform:"web", inject:[…], immediately:true}`；profile 里同一个包要**同时**进 `dependencies` 和 `dsh.profile.bundles`。
`immediately` 只影响**预取层**（脚本加载 + 工厂注册），不给 apply 优先级；模块副作用在 materialization 时发生。

### 2.4 设置持久化：官方不开放

第三方 settings 命名空间不在官方白名单内（会得到 `settings-not-exposed`）。因此设置只能自建：**host 路由 + 自落盘 `$DSH_HOME/codefall.json`（原子写）+ localStorage 首帧同步**。这也意味着**任何需要首帧正确的配置都必须由 host 半边在 index 渲染时同步读出**——客户端读设置是异步的，赶不上第一帧。

### 2.5 就绪信号：官方没有

`settled` 是 shell 内部的 `KernelSignal`，没有公开服务或事件。可行替代：

1. **首选**：客户端半边往 `shell.overlay` 挂第一个组件——`renderApp()` 只在 settle 之后运行，**首次挂载即"界面已就绪"**；
2. 首帧脚本用 `MutationObserver` 盯 `#root`；
3. 轮询 `ctx.get('appShell') !== undefined`。

无论用哪个，都必须配一个**独立看门狗超时**，保证客户端半边没加载成功时也能撤掉遮罩。

### 2.6 明确避开

| 不要做 | 原因 |
| --- | --- |
| `registerFallback` | 唯一席位已被 `dsh-host-frontend-static` 占据，第二次注册抛错 |
| 注册到 `root` slot | 会遮住 AppFrame；用 `shell.overlay` |
| 改 `dist/index.html` | 重装即回滚，且属于改宿主 |
| 依赖 tap 之间的相对注册顺序 | 官方声明 row order 无加载语义 |
| 用 `--dsw-alias-brand-primary` 当"蓝色总开关" | 它在明暗两种模式下都是**中性色**，真正的蓝色品牌位是 `--dsw-alias-brand-primary-new-colorprimary-new-color` |
| 只把遮罩写在客户端 React 树里 | settle 之前只渲染 loading 页 |

---

## 3. 产品边界与首版范围

**首版做**：绿色数字雨开机动画、标题字符显现、真实就绪交接、可跳过、失败放行、`prefers-reduced-motion` 降级、浅色模式分支、绿色语义主题覆盖、设置与同源预览。

**首版不做**（不得增加启动成本）：常驻动态壁纸、视频播放、音效、摄像头、鼠标视差、3D 穿梭、节日素材、主题市场、多套渲染器、WebGL/GPU 计算。

**主题边界**：只承诺"官方界面语义强调色的蓝色改绿"。图片内颜色、用户内容、代码语法配色、第三方插件、操作系统原生控件不在承诺内；代码高亮是否一并改绿，留到实际预览后决定。

---

## 4. 预期效果

### 4.1 冷启动时间轴（全部是待实测的设计目标）

| 阶段 | 目标画面 | 行为规则 |
| --- | --- | --- |
| 首帧（脚本执行前） | 底色 = 官方 dark `#151517`，无白屏无蓝闪 | 由 head `<style>` 完成，不依赖 JS |
| t≈0（body classic script） | 满屏画布，**约 1/3 的列已处于下落中段** | 预置雨迹，首帧就"在下雨"，不从零开始滴落 |
| 0–300 ms | 雨头（白绿）错落亮起，各列速度/尾迹长度/亮度不同 | 宿主继续正常加载，动画不阻塞 |
| 300–700 ms | **（可选）**中央字符逐位稳定为 `titleText` | **默认无标题**：`titleText` 为空时不画标题、不挖暗带，就是纯净数字雨 |
| 加载持续 | 低密度雨，**（可选）**一行真实状态文案 | 文案默认也为空；**不伪造百分比** |
| 应用就绪 | **雨继续下**（`interaction`）或按 `minDisplayMs` 收尾 | 就绪只表示"可以放行了"，不再等于"立刻收工" |
| 用户交互 | 停止生成新雨头，尾迹消退 + 淡出 | 目标 200–300 ms 内交出可操作界面 |
| 跳过（点击 / Esc） | 120 ms 淡出 | 与"交互"同一条路径；跳过 ≠ 已加载完成 |
| 异常 / 超时 | 撤掉遮罩，露出宿主自己的加载或错误界面 | 绝不掩盖诊断信息 |
| 长时间无人 | 20 s 后降档到 12 fps，60 s 后**停止出帧**（保留最后一帧） | 交互监听与出帧无关，随时仍可结束 |
| `prefers-reduced-motion` | 静态帧或短淡入 | 不开 rAF 循环；**交互等待规则照旧生效** |
| 浅色模式 | 浅底 + 深绿"墨迹雨"，或静态标题淡入 | 见 4.3 |
| 正常结束 / 卸载 | 无残留 DOM、无监听、无定时器、无持续重绘 | 唯一长期效果是主题覆盖层 |

### 4.1.1 结束方式（`dismiss`）

这是**产品性格开关**，两种模式都在：

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| **`interaction`（当前默认）** | 雨一直下，直到用户**移动鼠标 / 点击 / 滚轮 / 任意按键**才结束 | 想要"开机画面被确认"的仪式感 |
| `ready` + `minDisplayMs: 3000` | 宿主就绪后满 3 秒自动放行 | **不想让任何操作被拦**（"3 秒"档） |

> **默认输出是纯净数字雨**：`titleText`、`statusText`、`hintReady`、`hintWaitingAcknowledged` 默认全部为空，屏幕上只有雨。
>
> ⚠️ **已知取舍（已接受，仅记录）**：文字提示本来是"可以进入了"的唯一线索。去掉文字后，`interaction` 模式在**没有任何可见反馈**的情况下等用户操作——画面与"卡死"不可区分。这不是 bug，是"纯净数字雨"换来的代价。
>
> 三种应对，按推荐序：
> 1. **用「3 秒」档**（`dismiss:'ready'` + `minDisplayMs:3000`）——根本不需要提示；
> 2. 把 `hintReady` 设回一句话（能力仍在，只是默认空）；
> 3. 加一个**非文字提示**（就绪后让雨整体极缓慢呼吸一次，约 ±6% 亮度 / 2.4 s）——**尚未实现**，需要时再加。

**为什么默认 `interaction` 不会变成"卡住人"**——四条安全规则同时生效：

1. **就绪前不邀请**：宿主没报告就绪时只显示真实状态，提示文案只在就绪后出现（否则用户会以为点了没反应）。
2. **过早交互也认账**：如果用户提前点了，状态行立刻变成「正在加载…」，并启动 `interactionGraceMs`（2.5 s）宽限；宽限到点仍无就绪信号就**直接交出宿主**（哪怕它在显示错误）——用户已经要求了两次，不能再拦。
3. **显示下限**：`minDisplayMs`（默认 900 ms）保证标题一定收敛完才可能放行，解决"还没定型就闪掉"。
4. **宿主永不就绪**：`timeoutMs`（默认 15 s）看门狗撤掉遮罩，露出宿主自己的加载/错误界面。**这条只看"从未就绪"，不是展示时长上限**——就绪之后等用户多久都合法。

鼠标移动作为结束信号有两处防误触：启动后 `interactionArmMs`（350 ms）内忽略（窗口可能正好开在指针下面），之后还要**累积位移**超过 `interactionMovePx`（14 px）才算数。

`ignoreSelector` 可让特定容器（例如设置面板里的预览卡）不参与判定。

### 4.2 视觉规格

- **运动模型**：字符位于**固定网格**，沿列下落的是**亮度波**而非字符位置；字符只以较低频率替换。每列有独立的起始位置、速度、尾迹长度、亮度 ⇒ 自然错落。
- **默认形态是纯净雨**：没有标题、没有文字、没有为标题让路而挖出的暗带（`titleText` 为空时 `titleBand()` 返回 `null`，整屏亮度均匀）。
- **着色**：雨头偏白绿，主体鲜绿，尾迹逐级衰减。
- **可读性**：中央标题区降密度与亮度；标题只经历少量字符替换后稳定，**不做整屏快闪、不重复播放标题**。
- **字形**：以数字 + ASCII 为主（贴合 "codefall" 的代码坠落语义），半角片假名作为可选项；字形**预渲染进离屏画布图集**，避免逐字符实时绘制与模糊。
- **禁止**：逐帧大范围 blur、逐字符 fillText、随机类名扫描 DOM。

### 4.3 主题影响面（含浅色模式分支）

通过 `ctx.theme.overrideTokens("dsh-codefall", {token: {light, dark}})` 按语义覆盖，**两个模式都必须给值**。按影响排序：

| 用途 | token | 备注 |
| --- | --- | --- |
| 链接 + **焦点环** | `--dsw-alias-state-business-primary` | 一处同时管链接与 `:focus-visible` 轮廓，杠杆最大 |
| 业务弱强调 | `--dsw-alias-state-business-tertiary` | |
| 真正的蓝色品牌位 | `--dsw-alias-brand-primary-new-colorprimary-new-color` | 原始值 `rgb(65,118,230)` |
| 信息按钮 | `--dsw-alias-button-info-fill` / `-hover` | |
| 用户气泡 | `--dsw-specific-bubble` / `-highlight` | |
| 侧栏选中强调 | `--dsw-specific-sidebar-nav-item-active-accent` | |
| 偏蓝标签 | `--dsw-alias-label-primary-bluish` | |
| 蓝灰过渡底 | `--dsw-alias-interactive-bg-active` / `-hover-accent` / `-hover` | |
| 彻底覆盖时 | `--dsw-static-blue-*`、`--dsw-static-deepseek-*` | 最后手段 |

> 上述 token 名已在 0.2.0-rc.2 的构建产物 CSS 中观察到，**完整覆盖清单在阶段 C 逐项核对**（官方明确"第三方主题是扩展点，不校验覆盖完整性"）。

**必须自己写的**：官方既无选区 token 也无 `::selection` 规则 ⇒ 文字选区改绿要我们自带 CSS。

**必须保留可区分**：成功 / 警告 / 错误语义色不能被绿色洗掉。

**浅色模式**：雨天生是深底，浅色模式下必须走另一套配色（浅底 + 深绿墨迹），或降级为静态标题淡入。**不允许把深色模式的亮绿直接搬到浅色模式。**

**首帧配色一致性**：主题必须从第一帧生效（host 半边把强调色写进注入的 style），避免出现"先蓝后绿"的颜色跳变。

### 4.4 设置

首版：启动动画开关、绿色主题开关、雨密度、速度、画质档位、标题文本、**结束方式（interaction / ready）**、显示下限、重播预览、恢复默认。

- 动画与主题**独立开关**；关闭动画仍可用绿色主题。
- 预览复用同一个渲染器与参数，避免预览与实际启动不一致；预览不刷新宿主、不修改真实播放标记。
- 浅色/深色可强制覆盖（默认跟随）。
- 闲置档位（`idleSlowMs` / `idleStaticMs`）与提示文案（`hintReady` / `hintWaitingAcknowledged`）也可配置，默认值 20 s / 60 s，文案为空。

**设置界面（阶段 D）**：客户端半边**优先注册一个自己的设置分区**（`settings.section`，`{id:'dsh-codefall', order:40, label:'开机动画'}`），让"在哪调这个插件"直接从设置导航就能回答；**并在分区契约不匹配时自动回退**到官方 `settings.general.item` 一行。两条路都**不用官方的 settings store**（第三方命名空间会得到 `settings-not-exposed`），而是读写我们自己的 `/codefall/api`。

> **澄清一个容易误会的点**：设置导航里的「通用设置」**不是本插件的**，它是官方 `@deepseek-ai/dsh-client-ui-settings-general` 的分区，装插件之前就在（桌面 profile 的 `cordis.patch.yml` 里本来就有那一行），它上面的「账号与余额」同样是官方的。我们曾经的形态只是它**里面的一行**。
>
> 回退链有三段且都有测试：分区注册成功 → 用分区；slot 拒绝注册 → 用通用设置里的行；slot 根本不存在 → 也回退到那一行。**最坏情况等于"保持原来那个样子"，绝不会没有设置界面。**

> 分区标题（导航里那一栏的名字）由 `client.js` 的 `SECTION_LABEL` 一个字符串决定，当前是 **`开机动画codefall`**——「功能 + 包名」：功能部分与官方导航项（通用设置／账号与余额／插件…）命名逻辑一致，包名部分提供品牌识别。改名字只需改这一个字符串，测试跟着它断言（不写死）。

| 界面控件 | 写入的键 | 属于哪一档 |
| --- | --- | --- |
| 结束方式：交互后结束 / 3 秒后自动继续 | `dismiss` + `minDisplayMs` | 策略（`ready` + `3000` 就是 3 秒档） |
| 雨密度（30%–100%） | `density` | 视觉 · A 档 |
| 雨速（×0.40–×2.50） | `speed` | 视觉 · A 档 |
| 画质：高 / 标准 / 省电 | `quality` | 视觉 · B 档 |
| 明暗：跟随 / 深色 / 浅色 | `appearance` | 视觉 · B 档 |

界面不做第三层映射：每个控件直接写它对应的键。滑杆拖拽**防抖成一次写入**（不是每个像素一次请求），离散选择**立即写入**——后者曾被我误实现成 `setTimeout(…,0)`，结果按钮点击会被卷进后面的防抖批次一起写，已修并有测试守着。

**为什么这些参数能中途改而不闪屏**——`setOptions` 按"要重建多少"分三档，这是动画参数 UI 得以成立的前提：

| 档 | 参数 | 代价 |
| --- | --- | --- |
| **A · 即时** | `density`、`speed`、`ghostShare` | 直接改**正在跑的**场景：速度按比例缩放现有列；密度变化让新列**从屏幕上方落进来**，不会凭空出现在画面中段 |
| **B · 只重建图集** | `quality`、`appearance`、`glyphs`/`charset` | 重画字形图集，下落不中断；列状态完全不动 |
| **C · 重随机** | `fontSize`、`fontFamily`、`columnSpacing`、`rowSpacing` | 网格本身变了，只能重建整场雨 ⇒ **因此不放进设置界面**，仅在 `codefall.json` 可调 |

`state().sceneRevision` 如实反映这三档：A/B 档不变，C 档 +1。测试就靠它断言"调参数没有重启画面"（真实浏览器实测：一次下发改动 5 个键，`sceneRevision` 保持 1，`activeColumns` 由 76 降到 29）。

**配置的两级来源**：

| 级别 | 覆盖哪些键 | 何时生效 |
| --- | --- | --- |
| 注入快照（Host 启动时生成） | **全部**，含 C 档网格参数 | 首帧；桌面端每次启动 |
| 运行时刷新（首帧之后 `fetch('/codefall/api')`） | 策略键 + **A/B 档视觉键** | 当次启动内立即生效；首帧**不等**这个请求 |

**为什么 C 档不进运行时刷新**：重随机会让画面肉眼可见地跳一下，而首帧之后无法预知这个请求何时到达；A/B 档没有这个约束，于是刷新它们就能让"设置"在两种形态下语义一致——**Web 版改完刷新即生效**；桌面端仍需一次页面加载（即重启），但取到的是最新值而不是过期快照。

> 设置持久化：`$DSH_HOME/codefall.json`（原子写，`/codefall/api` 回环限定 + JSON-only + 大小上限）。

### 4.4.1 绿色主题（token 覆盖层）

**需求**：保留原本的白色字体与黑色背景，把蓝色系的品牌色换成与数字雨相配的绿色。明暗两套各自成阶。

**样式体系是三层**（从 ui-theme 的 bundle 里抽出来量过，不是推测）：

| 层 | 例子 | 规模 |
| --- | --- | --- |
| `--dsw-static-*` 原始色阶 | `--dsw-static-deepseek-500: #4176e6` | 320 条声明 |
| `--dsw-alias-*` 语义别名 | `--dsw-alias-link: var(--dsw-static-deepseek-400)` | 231 条 |
| 组件消费 | 组件 CSS 里 **436 处** `var(--dsw-*)` | — |

因为别名绝大多数是 `var()` 引用，**只覆盖原始色阶**就能带动所有指向它的别名（包括 `color-mix(in srgb, var(--dsw-static-deepseek-500) 70%, …)` 这类计算式）。这就是为什么覆盖层是 **29 条**而不是逐个别名改三十条。

**"保留白字黑底"不是妥协，而是这层结构自己的边界**：`--dsw-static-neutral-bluish-*`（`#0f1115` 近黑、`#f9fafb` 近白）就是墨色与底色，而 `--dsw-alias-brand-primary` 本身也不是蓝色——浅色下是近黑 `#0f1115`，深色下是近白 `#f9fafb`。

> ⚠️ **陷阱**：`--dsw-static-neutral-bluish-*` 有 7 个会被"按色相分类"判成蓝色（hue 210–222、饱和度 17–28）。如果照着"色相是蓝就绿"去做，**会把白字黑底染绿**。所以清单是量出来的，不是看名字猜的。

**映射规则**（`tools/green-map.mjs` 生成，不手写）：

| 维度 | 处理 | 理由 |
| --- | --- | --- |
| 明度 L | **保持不变** | 设计系统的全部对比度关系建立在明度上，保 L 才能"换皮不改可读性" |
| 色相 H | → **145°** | 数字雨自己的绿：`#22c55e`(145) / `#4ade80`(142) / `#86efac`(141) |
| 饱和度 S | 收进 **55–80%** | 原蓝色是 77–100%，直接搬过来是荧光绿；雨的绿是 68–77%。已经偏灰的 tint（6–14% 透明度的交互层）保留自身饱和度 |
| 透明度 | **保留**（含 8 位 hex） | 别名层里有 3 个带 alpha 的蓝色 tint，丢弃 alpha 会变成实色 |

一个有力的验证：`--dsw-static-deepseek-400`（`#7aaaff`，L=74）映射成 **`#87f2b4`**，而数字雨深色系里同明度的那一档正是 **`#86efac`（L=74, S=77）**——设计系统自己的明度阶梯正好落在雨的色阶上。

**按决定不动的东西**（生成器与测试双重断言，不是注释里的承诺）：

| 类别 | token |
| --- | --- |
| 语义状态色 | `--dsw-alias-state-success/warn/error-*` |
| 危险色 | `--dsw-alias-code-diff-*`、`--dsw-alias-file-diff-*`、`interactive-bg-hover-danger` |
| 中性墨色/底色 | `--dsw-static-neutral-*`、`--dsw-static-neutral-bluish-*`、`--dsw-alias-label-*`、`--dsw-alias-bg-base` |
| 其他色相 | `--dsw-static-amber-*`、`--dsw-static-red-*`、`--dsw-static-green-*` |

**语法高亮**：Shiki 用的是 CSS 变量模式（`--shiki-token-*`），所以**是可覆盖的**——这回答了我上一轮的未确认项。但只绿了它的两个蓝色（`constant`、`link`）；`keyword` 粉、`parameter` 橙、`function` 紫、`comment` 灰保留，因为那是**功能性色码**（每个 token 类型一个可区分色相），全绿换来的是可读性下降而不是主题感。

**注册位置**：`ctx.theme` 是**浏览器侧**的服务（`ThemeRuntime` 与 token 样式表都在 ui-theme 的 client bundle 里），所以 override 由**客户端半边**调用：

```js
var inject = ['slots', 'theme']        // ← theme 必须写在这里
themeDispose = ctx.theme.overrideTokens('dsh-codefall:green', buildTokens(hue))
```

> ⚠️ **踩过的坑（务必保留）**：`theme` 服务**存在**但**没写进 `inject`** 时，DSH 的 guard 直接抛错——
> `service "theme" is not injected. Declare it: inject: ['theme', …] on your plugin`
> ——而这个抛错对插件激活是**致命**的：客户端半边 `apply()` 一抛，加载器报 `dsh-codefall: failed`，**整个 web boot 失败、应用弹「无法启动」对话框**。当时我写的是 `inject = ['slots']` 却直接读 `ctx.theme`；应用的崩溃恢复随后摘掉了插件、把 `cordis.patch.yml` 改名备份并重置了部分 profile 偏好（见"回退与恢复"一节）。
>
> **为什么离线测试当时抓不到**：假 ctx 不实现 guard 语义，"读未声明的服务会抛错"测不出来。现在假 ctx 的声明列表**直接从 `exports.inject` 推导**，于是"声明 ⊇ 使用"由构造保证——谁把 `theme` 从 inject 里拿掉又去读它，离线立刻失败（有专门测试）。
>
> 写法取自**野外验证过的第三方插件** dsh-dream-skin：`inject = ['slots','locale','theme']` + 直接读 `ctx.theme`。

官方注释：*stacks partial token layers over the active theme without touching the registry*，返回一个**只卸载自己这一层**的 disposer。`validateOverrides` 要求每个值都是 `{ light, dark }` 成对字符串——传裸字符串会直接抛错（"a single value goes illegible when the user switches color scheme"），所以明暗两套是**接口强制**的，不是我们的选择。

| 项 | 值 |
| --- | --- |
| 开关 | `theme`（默认 `true`），设置里「绿色主题：开/关」，**改完立即生效** |
| 色相 | `greenHue`（默认 `145`，范围 **110–175**），设置里「绿色色调」滑杆 + 三个预设，**拖动即时生效** |
| 生效方式 | 客户端半边激活时 `GET /codefall/api` 读一次；此后每次保存成功即 `syncTheme()`；滑块拖动时**先应用再落盘** |
| 覆盖被拒 | try/catch 兜住 ⇒ 应用保留自己的配色，不会因主题失败而激活失败 |
| 卸载 | 经 `ctx.effect` 注册 disposer，插件卸载时移除该层 |
| 生成 | `node tools/green-map.mjs --emit` 写入 `lib/client.js` 的哨兵之间（免构建插件没有相对 import 可用），可重复执行且幂等 |

### 4.4.2 机制 A：色相是活的设置

**决定（已确认的设计决定）**：绿色不做成写死的表，而是**运行时算出来**——只给一个色相旋钮，拖动即时生效。

**为什么不写死**：映射是纯数学（保 L、换 H、钳 S、保 alpha）。写死意味着每换一次绿都要重新生成、重启、再看；而运行时算意味着**应用本身就是预览**——拖动 → `overrideTokens` 重注册一层 → 立刻看到。这次我们为"改代码才生效"付过一次昂贵代价（重启 + 一次启动失败），配色调参不该再有这种成本。

**改动量**：`client.js` 里携带 **29 条原始蓝色值**（明暗各一），绿色在 override 前算出。

| 项 | 值 |
| --- | --- |
| 唯一旋钮 | 色相 **110–175°**，默认 **145°** |
| 预设 | **雨绿 145°**（默认，= 数字雨自己的绿）/ **经典 120°** / **青碧 165°** |
| 色调跟随 | `--shiki-token-constant` 与 `--shiki-token-link` 两个蓝**跟着色相同步** |
| 改色相的动作 | 卸载旧层 → 用新色相重算 29×2 个颜色 → 注册新层（毫秒级） |
| 同一色相重复同步 | **空操作**（不产生多余的注册/注销抖动） |

**代价与对策**：生成文件不再是"最终颜色"的唯一真相——颜色是算出来的。所以：

- `tools/green-map.mjs --emit` 现在输出**原始色值**（`var()` 引用会被解析成具体蓝值，否则运行时没有色相可算）；
- 它同时输出**黄金样本** `tools/fixtures/green-145.json`；
- 测试断言：**在 145° 时，运行时的 29×2 个颜色必须与生成器逐字节相同**。数学被钉住，A 不会带来悄悄漂移。
- 另一条测试断言 **HSL 明度跨色相不变**（实测 `0.578 / 0.578 / 0.578`）——这才是"换皮不改可读性"的依据。

### 4.5 Windows 标题栏图标（最小化/最大化/关闭）

**先说结论：这三个按钮盖不住。** 它们是 Electron 的窗口控件叠加层（WCO），由 Chromium 画在**窗口 caption 区、网页内容之上**——页面里任何 `z-index` 都到不了那一层。壳的 `lib/main.js` 就是证据：

```js
...process.platform === "win32" && primary ? {
  titleBarStyle: "hidden",
  titleBarOverlay: { height: 40, color: chromeFallbackFill(),
                     symbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115" }
} : {},
```

壳也只暴露 `setTitleBarOverlay({color, symbolColor})`——**只能改颜色，没有可见性开关**。

但页面侧有一根杠杆。preload（`lib/preload-windows.js`）会建一个探针元素，把它的两个计算样式当作 caption 的填充色与图标色发给壳：

```js
const probe = document.createElement("span");
probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;" +
  "background-color:var(--dsw-specific-sidebar-fill);" +   // → caption 填充色
  "color:var(--dsw-alias-label-primary)";                  // → 图标颜色
document.body.append(probe);
// send(): color = probe 的 backgroundColor, symbolColor = probe 的 color
// 触发时机：document.body 的 style / data-ds-dark-theme 变化，或 head 变动
```

于是做法是：**把探针的 `background-color` 和 `color` 都改成雨自己的底色**（深色 `#151517` / 浅色 `#ffffff`）⇒ 标题栏那条底色与图标**一起融进雨里**。改完碰一下 `document.body.style` 触发 preload 重发；交接时把探针的 `cssText` **原样还原**再碰一次，图标与底色立刻回来。

> ⚠️ **这是第二版，第一版是错的。** 第一版只把 `color` 设成"探针自己的 `backgroundColor`"（即壳的中性色 `#1b1b1c`）——图标确实隐了，**但那条底色还是 `#1b1b1c`，比雨的 `#151517` 亮 6/6/5**，于是窗口顶部留下一道肉眼可见的灰带。**这一点是评审指出的**：既然要和雨融在一起，就该用雨的底色，而不是壳的底色。
>
> 记下来的教训：把目标定成"隐藏前景"时，别忘了**背景也在画面里**。

| 项 | 值 |
| --- | --- |
| 开关 | `hideWindowControls`（默认 `true`，仅 Windows 生效） |
| 改什么 | 探针的 `background-color` + `color` 都设成雨底色（`#151517` / `#ffffff`），**不是**壳的中性色 |
| 点击 | 只改颜色，命中区域不变 ⇒ 窗口始终可最小化/关闭 |
| 生效范围 | 只在启动遮罩存在期间；`finish()` 的**每一条**结束路径都会还原（正常/跳过/失败/超时/`destroy()`） |
| 主题跟随 | caption 底色随明暗变化时，隐藏色跟着变（`refreshCaptionColor()`） |
| 探针未就绪 | preload 可能晚于注入脚本挂载 ⇒ 每 100 ms 一次、最多 30 次重试 |
| 非 Windows / Web 页 | 找不到探针 ⇒ 完全空操作 |

> **必须诚实标注：这是一个 hack。** 我们动的是另一个组件的私有探针（改它的内联 `color`），依赖 preload 当前的实现细节。风险与后果：
> - **最坏情况**：还原路径被打断 ⇒ 图标一直不可见，**但依然可点**（窗口不会失去操作能力），且**下次启动自动恢复**（探针每次启动都是新建的）。
> - 鼠标悬停时 Windows 仍会画悬停态，所以"看不见"不等于"点不到"。
> - preload 若改实现（改探针特征或改发送触发条件），这个功能会**静默失效**；`caption-hidden` / `caption-restored` 事件可用于确认它到底有没有生效。
> - 不想要就把 `hideWindowControls` 设为 `false`。

### 4.6 性能预算（待测目标）

| 项 | 目标 |
| --- | --- |
| 默认帧率 | 30 FPS，必要时自动降档 |
| 资源体积 | 传输压缩后 ≤ 100 KB（**信心值 15–25 KB**：免构建手写 bundle + 预渲染图集，见 6.1） |
| 运行时网络请求 | 动画不需要任何外部请求 |
| 启动影响 | 中位额外耗时 ≤ 100 ms |
| 交接时间 | 就绪后 ≤ 300 ms 完成视觉退出 |
| 结束后负载 | 0 持续动画循环、0 后台重绘 |
| 交互 | 点击跳过与 Esc 可用；错误时宿主界面可见 |
| 对比度 | 正文 ≥ 4.5:1，关键非文本标识 ≥ 3:1 |
| 上限 | DPR 上限（≤2）、列数上限、画布总像素上限 |

测量必须**分阶段**（下载 / 脚本执行 / 渲染初始化 / 宿主就绪 / 遮罩退出），不能只报平均 FPS；记录机器、分辨率、缩放、宿主版本、冷热启动条件，取多次运行的中位数与长尾。

---

## 5. 参考

### 5.1 视觉质量标杆

- [Rezmason/matrix](https://github.com/Rezmason/matrix) · [在线演示](https://rezmason.github.io/matrix/) —— 数字雨质感的天花板：固定字符网格、亮度波、尾迹、MSDF 字形、Bloom。**只作为质量参照，不引入其 WebGL/GPU 依赖**（与"轻量"目标冲突）。
- 电影《黑客帝国》原始数字雨：半角片假名 + 数字 + 拉丁字符的混排，以及"雨头纯白"的处理。

### 5.2 可直接借鉴的实现范式

| 项目 | 借鉴什么 |
| --- | --- |
| [weibaohui/dsh-matrix](https://github.com/weibaohui/dsh-matrix)（`@weibaohui/dsh-matrix` 0.7.0） | **同宿主下已被验证能跑的数字雨**：Canvas2D + `destination-out` 尾迹、多配色、密度/速度/字号配置项、完整 config schema。注意它是**常驻背景**，不是开机动画 |
| [yannicksong0106/dsh-550c-boot](https://github.com/yannicksong0106/dsh-550c-boot)（`dsh-550c-boot` 0.3.3） | 唯一自述明写 host 侧 `web:index-inject` 首帧 + shadow-root 舞台 + 跳过 + 设置行的开机动画；其 `dsh.engines.dsh` 版本门槛写法值得照抄 |
| [RevolutionLA/dsh-dream-skin](https://github.com/RevolutionLA/dsh-dream-skin)（10.8.0） | `ctx.theme.register/setTheme/overrideTokens` + settings 行 + host 路由持久化的最佳范例；**手写 `__ModuleLoader__` bundle、免构建**（与本方案一致） |
| [orxz/deepseek-harness-themes](https://github.com/orxz/deepseek-harness-themes) | 主题 token 契约 + 批量注册，最干净的主题注册写法 |
| [KylinQ01/dsh-startup-animation](https://github.com/KylinQ01/dsh-startup-animation) | `<head>` 预注入防闪屏、三档画质、`prefers-reduced-motion` 降级的组织方式 |

### 5.3 竞品自曝的坑（直接进我们的验收清单）

- dream-skin：CI **跳过** computed-style 门禁（只有维护者机器真跑过）；手抄宿主 CSS 类名会随宿主改哈希而**静默失效**；其不透明度下限**不是** WCAG 对比度认证；装完**必须重启**；npm 有 24 h 冷却期。
- 550c-boot：**覆盖不了 Electron 窗口本身**；首帧只是纯色，不是插件的第一帧；macOS 标题栏按钮不参与动画。
- `dsh-matrix`：常驻 = "结束后零负载"这条天然不达标。
- 结论：我们**不抄宿主类名**（只用语义 token），**不承诺**做不到的事（窗口标题栏、操作系统控件），并把"重启生效"写进安装说明。

### 5.4 命名参考（已实测）

这个生态里 `matrix` 几乎等于 **Matrix 协议（IM 桥接）**，不是电影：`dsh-matrix-agent`、`dsh-matrix-connector`、`@lamplitisles/dsh-matrix`、`@barryfan2045/dsh-matrix` 全是 IM 桥接；唯一做数字雨的 `@weibaohui/dsh-matrix` 已占掉 `dsh-matrix`。

| 名字 | npm registry | 说明 |
| --- | --- | --- |
| **`dsh-codefall`** | ✅ 404 可注册 | **已选定**：短、零歧义（代码坠落）、搜索友好 |
| `dsh-matrix-rain` | ✅ 可注册 | 备选，与旧仓库名一致 |
| `dsh-digital-rain` | ✅ 可注册 | "数字雨"直译 |
| `dsh-nebuchadnezzar` | ✅ 可注册 | 影迷向（Matrix 飞船名），辨识度最高但拼写门槛高 |

---

## 6. 技术骨架（描述，非代码）

### 6.1 双半结构

```
dsh-codefall/
├─ package.json         exports["."]=host 半边, exports["./client"]=浏览器半边
├─ cordis.patch.yml     向 profile 插入一行 loader row
├─ lib/index.js         host：index-inject 首帧行 + 配置路由 + 原子落盘
├─ lib/client.js        手写 __ModuleLoader__ bundle（免构建、不依赖打包器）
└─ assets/              预渲染字形图集（如需）
```

**免构建是刻意的**：dream-skin 用 152 KB 手写 `client.js` 证明了这条路的可行性，省掉构建链就省掉了启动期与维护成本，也让"轻量"可验证。

### 6.2 开发回路（纯桌面端）

desktop profile 拒绝 CLI 管理，但 `link:` 依赖可以绕过发布：

1. 备份 `profiles/desktop\package.json` 与 `cordis.patch.yml`；
2. 在 profile 的 `dependencies` 加 `"dsh-codefall": "link:D:\\dsh-codefall"`，并在 `dsh.profile.bundles` 末尾加 `"dsh-codefall"`；
3. 在该目录跑 pnpm 安装；
4. **重启桌面应用**（第三方 host 半边插件没有热重载）。

代价：每次迭代要重启。因此**视觉部分先在仓库内做离线原型**（可独立打开的 HTML，阶段 A），把画面与节奏调对之后再进宿主。

**离线验收工具链**（都不需要起宿主）：

| 命令 | 用途 |
| --- | --- |
| `node tools/smoke.mjs` | 渲染器行为（首帧、缩放、消退、复活、纯净雨无暗带） |
| `node tools/host-test.mjs` | 用假 Cordis 上下文 + 假 DOM **真的把注入脚本跑起来**：结束策略全分支、运行时策略刷新、设置路由边界 |
| `node tools/client-test.mjs` | 用极小 React 桩**真的把设置行渲染并点击一遍**：两个 slot 注册、失败隔离、GET/POST 往返 |
| `node tools/render-frames.mjs` | 渲帧成 PNG，逐帧比对视觉 |
| `node tools/extract-theme-css.mjs` | 把主题插件的 8 张样式表（token 三层 + shiki）从 bundle 里抽出来 |
| `node tools/theme-audit.mjs` | 按色相分类全部 token，回答"哪些是蓝的" |
| `node tools/green-map.mjs [--emit]` | 生成绿色覆盖层；带一组断言（禁改 token 不得出现、值必须是成对字符串、覆盖后不得残留蓝色） |
| `node tools/theme-reach.mjs` | 量化"token 主题能覆盖到哪"：图标是否 `currentColor`、蓝色是否只存在于 token 层 |
| `node tools/headless-boot-page.mjs --dismiss interaction --ready-at 700` | 生成自包含测试页；配合 `tools/serve-fixture.mjs` 起一个同源 fixture（`/` + `/codefall/api`），再用 Edge `--headless=new --no-sandbox --virtual-time-budget=… --dump-dom` 跑。页面侧状态写在 `<pre id="cf-probe">` 里，headless 也能读到内部状态 |

> headless 的 `--virtual-time-budget` **只推进定时器、不驱动 rAF 出帧**，所以截图拿到的是首帧——这正好用于验证"首帧即满屏"和全部定时器/事件驱动的结束逻辑。

### 6.3 主题覆盖清单

见 4.3 的表。实现要点：`overrideTokens` 返回 disposer，卸载时必须释放；覆盖层按注册顺序折入活动快照，不要自己管主题状态。

### 6.4 首帧脚本的自包含约束

注入的 body classic script 必须在**无网络、无模块系统**的前提下独立跑完首帧：内联渲染器 + 参数，不 import、不 fetch。体积控制在 ~10 KB 量级，其余交给客户端半边接管。

---

## 7. 分阶段计划

**阶段 A：离线视觉原型** —— **已产出（2026-10-08），待你在浏览器里验收**

| 文件 | 作用 |
| --- | --- |
| `lib/renderer.js` | 纯渲染器。零依赖、不碰 DOM（canvas 由外部注入），因此既能在浏览器跑，也能在 Node 里离线渲帧；带 seed，画面可确定性复现。可被 host 半边原样内联进首帧脚本 |
| `lib/boot.js` | 首帧控制器。拥有覆盖层、动画循环、跳过手势、看门狗、就绪交接、缩放与可见性处理，把渲染器当纯像素引擎驱动 |
| `preview/index.html` | 阶段 A 原型。可离线打开，含模仿宿主的界面（用来判断交接是否干净）与四种模拟就绪时间（0.3s / 2.5s / 8s / 失败），外加深浅色、画质、密度、速度、标题、弱动画开关 |
| `tools/render-frames.mjs` | 离线渲帧工具（`--appearance` / `--quality` / `--at` / `--seed`），产出可逐帧比对的 PNG |
| `tools/smoke.mjs` | 18 项断言，覆盖首帧、缩放、消退、复活、销毁 |

**已用离线渲帧验证**（`node tools/smoke.mjs` 全绿）：

- 首帧就是满屏雨景：顶 1/3 区域非背景像素覆盖率 **4.47%**，即约 1/3 的列一开始就在屏幕中段，不从零滴落。
- 网格 **91 列 × 41 行**（1280×800，fontSize 18，列距 1.35），每帧约 **500–620 次** drawImage。
- 标题在 **722 ms** 完成收敛（240ms 起锁、逐字符 52ms 错峰、170ms 落定）。
- 窗口缩放**不重置**画面：91 列 → 71 列后雨继续下，列头位置按行数等比换算。
- 就绪交接：消退 180 ms + 淡出 120 ms = **300 ms**，落在预算内；消退结束后**零绘制**。
- `destroy()` 幂等；`reset()` 可显式复活一场已结束的开机（设置面板的同源预览将来要用）。

**尚未验证（必须在浏览器里做）**：真实 FPS 与单帧耗时、跳过手势与 Esc、`prefers-reduced-motion`、后台标签页的 rAF 节流、DPR 缩放下的清晰度、以及浏览器是否解析 `Consolas, monospace` 回退列表（原生 canvas 不解析，这是一个已踩过的坑）。

**阶段 B：桌面端接入** —— **代码已产出并已安装（2026-10-08），待重启桌面应用后验收**

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | host 半边。注册一个 `webserver/index-inject` 订阅者，把渲染器与控制器**内联**进每份 index.html 的首帧；另提供一个设置路由 `/codefall/api`（回环限定、原子落盘到 `$DSH_HOME/codefall.json`） |
| `lib/client.js` | 浏览器半边（手写 `__ModuleLoader__` bundle，免构建）。往 `shell.overlay` 挂一个不渲染任何东西的探针，**它的首次挂载就是"客户端树已 settle、界面可交互"**，据此交出首帧 |

**三个关键设计决定**：

1. **内联 + mtime 缓存**：`renderer.js` / `boot.js` 在**每次 index 渲染时读盘内联**。因此改动画**只需刷新浏览器**，不用重启桌面应用；只有改 `lib/index.js`（loader row 本身）才需要重启。这是把迭代成本从"每次重启"降到"每次刷新"的核心。
2. **追加而非 prepend 注入行**：官方主题引导（`dsh-client-ui-theme`）在同一个锚点 prepend 了一个 body 脚本，把**持久的明暗偏好**写进 `<body>`。我们追加，于是它先跑完 —— `appearance: 'auto'` 因此能读到真实答案（`data-ds-theme-source` + `body[data-ds-dark-theme]`），而不是去猜操作系统偏好。只有官方引导没跑时才回退到 media query。
3. **三条就绪路径，任何一条都能放行**：① 客户端半边交出首帧（准确）；② `#root` DOM 增长的兜底启发式（客户端半边没加载成功时用，带 500ms 下限与元素数阈值）；③ 6 秒看门狗。**任何一条都不会让用户被雨幕困住。**

**离线验证**（`node tools/host-test.mjs`，**36 项全绿**）：用假 Cordis 上下文 + 假 webserver + 一个够用的假 DOM，**真的把注入脚本跑起来**，覆盖：行注入、`animation:false` 零输出、脚本可编译、脚本无法闭合自身标签、overlay 建立、dark/light/无主题插件三种外观判定、就绪交接、DOM 增长兜底、看门狗放行、消退+淡出、`prefers-reduced-motion` 静态路径、以及设置路由的 415/400/403/405 边界。

**安装记录**：`dsh plugin --profile desktop add link:<repo>` → pnpm 建立 Junction（`profiles/desktop\node_modules\dsh-codefall` → `<repo>`），并**由插件管理器自动把 `dsh-codefall` 写进 `dsh.profile.bundles`**（无需手改）。备份在 `backup/desktop-profile-<时间戳>\`。

**回滚**：把该备份目录里的 `package.json` 与 `cordis.patch.yml` 拷回 `profiles/desktop\`，删除 `node_modules\dsh-codefall`，重启桌面应用。

**重启后要看的**：① 加载瞬间满屏绿雨（不是常规加载页）；② 点击/Esc 可跳过；③ 界面 settle 后约 300ms 内雨幕消退、界面可交互；④ 没有任何残留遮罩。**若什么都没出现**，说明我们的 bundle/row 没被加载，下一步就是查宿主日志与 loader 树。

**仍未验证（需要浏览器 + 真实宿主）**：真实 FPS 与单帧耗时、跳过手势与 Esc 的实感、`prefers-reduced-motion`、后台标签 rAF 节流、DPR 下的清晰度、以及 `shell.overlay` 注册契约是否如预期（若注册失败会打 warning 并退到 DOM 兜底）。

### 阶段 B 诊断记录（2026-10-08，重启后排查）

重启后「什么都没发生」，排查拿到三条硬事实：

| 事实 | 证据 |
| --- | --- |
| **host 半边确实被加载并激活** | `GET http://127.0.0.1:19387/codefall/api` → 200 + 完整默认配置。设置路由注册成功，说明 `ctx.inject(['webServer'], …)` 回调确实跑了 |
| **loader 确实接受我们的 bundle 并插入了行** | 用真实 0.2.0-rc.2 loader 组合探针 profile（`profiles/codefall-probe`，不碰 desktop profile），`--dump-config` 输出里出现 `# == dsh-codefall` / `- id: codefall` / `name: dsh-codefall` |
| **`frontend-static` 确实走 `renderIndex`** | asar 内 `dsh-host-frontend-static/lib/index.js`：`ctx.webServer.renderIndex(await readFile(distIndex, "utf8"))` —— 结构化注入行会被渲染，不是只跑 `applyIndexTaps` |

**修掉一个真 API 误用**：`ctx.on(name, listener, options?)` **没有 label 参数**（见 `cordis/lib/types/events.d.ts`），我原先传的字符串被当成 options。正确写法是 `{ prepend: false }` 或省略。只有 `ctx.effect(fn, label)` 才有 label。

**据此改为双机制 + 幂等守卫**（不再猜哪种生效）：

- 机制 1：`ctx.on('webserver/index-inject', …)`，注册在**插件自己的 context** 上 —— 该事件不需要服务，不该被 service inject 门控；
- 机制 2：`ctx.webServer.tapIndex(html => …)` 兜底，把脚本插到 `<body>` 开标签之后；
- 两者共用哨兵 `__codefallOptions`：HTML 里已有哨兵时机制 2 空转，不会重复注入。

**并加自诊断**：`GET /codefall/api?diag=1` 返回 `{structuredRows, tapRenders, tapSkipped, lastInjectAt, lastScriptBytes, lastError}` 及 boot 文件可读性。**下次重启后这一条就能指出断在哪一环**：两个计数都是 0 → 根本没有 index 渲染（页面没被重新加载）；`structuredRows>0` 却仍无雨 → 断在浏览器侧。

**注意**：桌面应用每次重启都会换启动令牌，而信任 cookie 绑定该令牌 —— **旧浏览器标签在重启后无法重新加载（401），必须用应用新打开的那个页面**。

### 根因与修复：覆盖层丢了定位样式（2026-10-08）

定位过程用了一个**可自我验证的探针**：用随附 web 模板初始化一个独立 profile（`dsh --profile <probe> --from-default-profile web --port 8099`），把插件 `link:` 进去自己启动。这样 `dsh web: …?token=…` 是**我自己的进程打印的**，于是我能直接读服务端吐出的 HTML —— 桌面 GUI 的 `/` 被信任栅栏挡住（`PROCESS_LAUNCH_TOKENS` 只存在于内存，磁盘上拿不到令牌）。

用真实 Chromium（Edge `--headless=new --no-sandbox`）加载隔离页后，拿到了确切的失败形态：

```html
<div id="codefall-boot" style="background: rgb(21,21,23);">
  <canvas width="1238" height="155" style="width:1238px;height:155px">
```

**覆盖层只有 `background`** —— `position:fixed` / `inset:0` / `z-index` 全部缺失。这是我在阶段 B 引入的错误：当时判断 head `<style>` 注入行"冗余"（理由是脚本会给覆盖层设内联样式），但脚本其实只设了背景色。后果连锁：

1. 覆盖层退回**正常文档流**，排在 `#root` 之前；
2. `wrap.clientHeight` 读成 **155**（画布的默认 150px 撑出来的），画布被做成 1238×155 的**一条**；
3. 那一小条还被应用自身的界面（`#root{height:100%}`）盖住 ⇒ 桌面端表现为**「什么都没发生」**。

**修复**：覆盖层改为**完全自包含的内联样式**，不再依赖任何 style 行；尺寸也不再测元素盒子，而是——固定定位的覆盖层**本来就等于视口**——直接取 `innerWidth/innerHeight`（同时新增 `host` 选项，为将来嵌到设置卡片里的预览预留 `position:absolute` 分支）。

**真实浏览器验证**（修复后）：

| 检查 | 结果 |
| --- | --- |
| DOM 中的覆盖层 | `position: fixed; inset: 0px; z-index: 2147483000; …` ✅ |
| 画布尺寸 | **1254×660**（跟随视口，不再是 155px 条）✅ |
| 截图像素 | 满屏绿雨 ✅（见 `tools/out/headless-AFTER-fix-first-frame.png`） |
| 8 秒后 DOM | `id="codefall-boot"` **消失** ⇒ 看门狗真的能撤掉遮罩 ✅ |

> headless 的 `--virtual-time-budget` 只推进定时器、不驱动 rAF 出帧，所以截图其实是**首帧**。这反而正好证明了设计目标：**第一帧就已经是满屏雨景**（此时标题还是随机字符，约 700ms 后才收敛为 HARNESS）。

**部署侧的重要后果**：`boot.js` 是**每次 index 渲染读盘**的，所以这个修复**只需要刷新页面就生效，不必重启桌面应用**。

**阶段 C：绿色主题覆盖**
建立 0.2.0-rc.2 的 token 清单，逐页检查会话、侧栏、设置、弹窗、菜单、输入框、工具卡片、加载状态；覆盖默认/悬停/选中/聚焦/禁用 × 浅深色；记录残余蓝色来源。

**阶段 D：设置、打包与交付**
设置持久化 + 同源预览、性能对比、资源清理检查、兼容版本记录，最后给安装/卸载说明与已验证版本列表。

---

## 8. 验收清单

- [ ] 启动画面是绿色数字雨；字符稳定、亮度波自然、无大范围闪烁。
- [ ] 首帧就是"在下雨"，不是从零滴落；无白屏、无蓝闪。
- [ ] 快速启动不被固定片头时长拖延。
- [ ] 慢启动、失败、超时都不被动画掩盖。
- [ ] 首帧 / 退出转场 / 主界面配色一致，无跳变。
- [ ] 蓝色标签、下划线、链接、选中图标已改绿；焦点环改绿。
- [ ] `::selection` 文字选区已改绿（官方无此 token）。
- [ ] 浅色模式有独立配色方案，不套用深色亮绿。
- [ ] 成功/警告/错误语义色仍可区分。
- [ ] 动画与主题开关独立生效，配置重启后保留。
- [ ] **`interaction` 模式下：宿主就绪后雨仍在；移动鼠标 / 点击 / 滚轮 / 按键任一即结束。**
- [ ] **过早交互被认账（提示变「正在加载…」）且 2.5 s 宽限后必定放行。**
- [ ] **宿主始终不就绪时，15 s 看门狗撤掉遮罩，露出宿主界面。**
- [ ] **长时间无人时降档、停帧；此时仍能一键结束。**
- [ ] 跳过、`prefers-reduced-motion`、后台暂停、窗口缩放可用。
- [ ] 动画结束与卸载后无残留覆盖层 / 监听 / 定时器 / 持续重绘。
- [ ] 给出可复现的性能记录与明确的宿主兼容版本。
- [ ] profile 安装步骤可逆，且记录了桌面壳检查点的实际行为。

---

## 9. 待拍板的开放项

1. **标题文本**：默认 `HARNESS`（这是产品的开机时刻），还是 `CODEFALL`（插件品牌）？设置项都支持自定义。
2. **GitHub 远端改名**：远端仍为 `4444Hao/dsh-matrix-rain.git`，是否改为 `dsh-codefall`（需在 GitHub 侧操作）。
3. **浅色模式策略**：浅底墨迹雨（默认建议）vs 静态标题淡入。
4. **字形集**：默认数字 + ASCII（贴合 codefall 语义），是否默认开启半角片假名。

---

## 10. 决策记录

| 日期 | 决策 |
| --- | --- |
| 2026-10-08 | 用户选择绿色数字雨 + 官方界面蓝色强调改绿 |
| 2026-10-08 | 本阶段只维护方案文档，不生成代码 |
| 2026-10-08 | 从精简 Canvas 2D 起步；渲染器最终选择由实测决定 |
| 2026-10-08 | **命名定为 `dsh-codefall`**（`matrix` 已被 IM 桥接占据） |
| 2026-10-08 | **目标锁定桌面端**；web profile 与其中的第三方插件不在考虑范围 |
| 2026-10-08 | 实测确认：0.2.0-rc.2 / desktop profile / HTTP GUI / 首帧注入链路可用 |
| 2026-10-08 | 采用双半插件 + 免构建手写 bundle；主题走 `ctx.theme.overrideTokens` |
| 2026-10-08 | 开发回路：`link:` 进 desktop profile，视觉部分先离线原型 |
| 2026-10-08 | 阶段 A 产出：纯渲染器 + 首帧控制器 + 离线原型 + 渲帧/冒烟测试 |
| 2026-10-08 | 阶段 B 产出：host 半边（内联注入 + 设置路由）与 client 半边（`shell.overlay` 就绪交接） |
| 2026-10-08 | 注入行**追加**而非 prepend，以便复用官方主题引导已解析的明暗偏好 |
| 2026-10-08 | 就绪判定改为三条路径：客户端信号 / DOM 增长兜底 / 看门狗 |
| 2026-10-08 | **实测推翻两个错误假设**：桌面窗口是 `dsh-app://app/`（localStorage origin 实证），不是 HTTP 页面；但它的注入走 **Host 启动上报 + IPC**，页面 `hM()` 明确支持 `{kind:'script', text}` 内联行 ⇒ 同一个包适配两种形态 |
| 2026-10-08 | 修掉根因：覆盖层丢了定位样式（只剩 background）→ 画布被做成 1238×155 一条藏在界面后 |
| 2026-10-08 | **结束方式改为默认 `interaction`**：雨一直下，直到移动鼠标/点击/滚轮/按键；附四条防卡死规则与闲置降档 |
| 2026-10-08 | **默认输出改为纯净数字雨**：`titleText`/`statusText`/`hintReady`/`hintWaitingAcknowledged` 全部默认空；标题与提示保留为可选能力（用户明确不要任何文字） |
| 2026-10-08 | 「3 秒」档不新增存储字段，就是 `dismiss:'ready'` + `minDisplayMs:3000`；设置界面将来以二选一呈现，底层仍是这两个键 |
| 2026-10-08 | **A+D 落地**：客户端半边注册 `settings.general.item` 设置行（自建控件 + 自有路由）；注入脚本在首帧之后 `fetch('/codefall/api')`，**只刷新策略键**，视觉参数仍只认快照 |
| 2026-10-08 | 纯净数字雨带来的"无可见反馈"取舍：**只在 README 记录，不实现非文字提示**（用户明确只要雨） |
| 2026-10-08 | **`setOptions` 拆成三档**（即时 / 只重建图集 / 重随机），使动画参数可以中途调整而不重启画面；C 档网格参数不进设置界面 |
| 2026-10-08 | 默认结束方式维持 **`interaction`**（用户确认），「3 秒」作为可选的第二档 |
| 2026-10-08 | 设置界面扩到 5 项：结束方式 + 雨密度 + 雨速 + 画质 + 明暗；运行时刷新随之覆盖 A/B 档视觉键 |
| 2026-10-08 | 设置入口从「通用设置里的一行」改为**自己命名的分区**，导航标题 **`开机动画codefall`**（契约取自真实第三方插件 dream-skin），并保留三段回退 |
| 2026-10-08 | 新增 `hideWindowControls`（默认开，仅 Windows）：启动遮罩期间把标题栏三图标的颜色改成 caption 底色使其不可见——它们是 Chromium 的 WCO，画在页面之上，**无法覆盖**，只能改色。已标注为 hack，并在每条结束路径还原 |
| 2026-10-08 | 标题栏隐藏**第二版**：第一版只改图标色，留下一条比雨底色亮 6/6/5 的灰带（**评审指出**）；改为底色与图标**都用雨底色**。教训：把目标定成"隐藏前景"时别忘了背景也在画面里 |
| 2026-10-08 | **绿色主题落地**：覆盖 29 个蓝色原始色阶（`deepseek-*`+`blue-*`）+ 4 处硬编码蓝色别名 + Shiki 的 2 个蓝；规则为**保明度、色相 145°、饱和度收进 55–80%、保留 alpha**。语义状态色/红/琥珀/中性墨色一律不动（生成器与测试双重断言）。`ctx.theme` 是浏览器侧服务，故由客户端半边注册，带开关且改完立即生效 |
| 2026-10-08 | 主题清单与映射**由工具生成**（`extract-theme-css` → `theme-audit` → `green-map --emit`），生成器带断言；`emit` 已验幂等。过程中生成器自身被抓出两个 bug：把已映射的绿值重新喂回 hue 判断（导致全部跳过）、声明正则要求必须有 `;` 或 `}`（静默丢弃每个块的最后一条声明） |
| 2026-10-08 | ⚠️ **事故与回退**：绿色主题第一版把 override 装在客户端半边，但只声明 `inject = ['slots']` 就直接读 `ctx.theme` ⇒ DSH 的服务 guard 抛错 ⇒ 插件激活失败 ⇒ **整个 web boot 失败、应用弹「无法启动」**。应用的崩溃恢复流程（`disableAllPlugins` → `sanitizeProfile`）把 `cordis.patch.yml` 改名备份、`bundles` 重置回官方基线，因此**插件与部分 profile 偏好被一并重置**。已回退代码（`client.js` 逐字节复原）并从备份恢复 profile。**教训**：假 ctx 必须实现 guard，否则"读未声明的服务"这类致命错误离线测不出来 |
| 2026-10-08 | 绿色主题**改为机制 A**：`client.js` 携带 29 条原始蓝色值，绿色**运行时计算**（保 L / 换 H / 钳 S / 保 alpha），唯一旋钮为色相 110–175°（默认 145°，预设 雨绿/经典/青碧），**拖动即时生效**；Shiki 的两个蓝跟着色相走；用黄金样本把运行时数学钉死在生成器上 |

---

## 11. 参考链接

| 资料 | 用途 |
| --- | --- |
| [Rezmason/matrix](https://github.com/Rezmason/matrix) | 数字雨质感标杆 |
| [weibaohui/dsh-matrix](https://github.com/weibaohui/dsh-matrix) | 同宿主已验证的 Canvas2D 数字雨 |
| [yannicksong0106/dsh-550c-boot](https://github.com/yannicksong0106/dsh-550c-boot) | host 侧首帧注入 + 设置行的开机动画范式 |
| [RevolutionLA/dsh-dream-skin](https://github.com/RevolutionLA/dsh-dream-skin) | `ctx.theme` + 免构建 bundle + host 路由持久化 |
| [orxz/deepseek-harness-themes](https://github.com/orxz/deepseek-harness-themes) | 主题 token 契约与批量注册 |
| [KylinQ01/dsh-startup-animation](https://github.com/KylinQ01/dsh-startup-animation) | 预注入防闪屏 + 画质档位 |
| 本机 `app.asar` 内 `@deepseek-ai/dsh-host-webserver` README | `index-inject` 注入表与 `tapIndex` 的权威说明 |
| 本机 `app.asar` 内 `@deepseek-ai/dsh-client-ui-theme` | 首帧 boot style/script 与 `ctx.theme` 的真实实现 |
| `tools/extract-app-assets.mjs` | 只读提取 asar 内官方源码的工具 |

> 第 5 节的第三方项目结论来自 2026-10-08 的在线检索与 README 阅读，**多数未安装运行**；开始实现时应固定所用提交或版本，并更新本表的验证状态。第 1、2 节的宿主事实全部来自本机实测。
