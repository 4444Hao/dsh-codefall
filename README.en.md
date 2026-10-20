# dsh-codefall

[简体中文](README.md) | **English**

Matrix-inspired digital rain, a rectangular light portal that opens to both sides, and an adjustable green UI theme for DeepSeek Harness.

[![tests](https://github.com/4444Hao/dsh-codefall/actions/workflows/test.yml/badge.svg)](https://github.com/4444Hao/dsh-codefall/actions/workflows/test.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Listed in [dsh-market](https://github.com/dsh-market/dsh-market).** Search for `dsh-codefall` in the market to install it. [View the catalog entry](https://awesome-dsh-plugin.com/p/4444Hao/dsh-codefall/).

[Install and use](#install-and-use) · [Settings](#settings) · [GitHub](https://github.com/4444Hao/dsh-codefall) · [npm](https://www.npmjs.com/package/dsh-codefall)

![Digital waterfall effect preview: looping green Matrix rain on a black background](docs/images/boot-dark.gif)

*Generated with the plugin's renderer. This GIF demonstrates the rain; it does not show the portal transition.*

## What it does

- **Digital-rain startup screen:** green character streams with no title or prompt by default.
- **Matrix light portal:** once the host UI is ready and you interact, a narrow rectangular portal opens from the center toward both sides to reveal Harness. A fade transition is also available.
- **Optional replay:** play on application startup, or replay when a supported desktop window is restored from the background or minimized state. Switching Web browser tabs does not replay it.
- **Green UI theme:** remap the UI's blue accent colors to green. Choose Rain, Classic, or Teal presets, adjust the hue, or turn the theme off independently.
- **Adjustable rendering:** control rain density, speed, quality, and light/dark appearance. Light mode uses dark green characters on a white background.

The animation uses Canvas2D without video or online animation assets. It releases the rain renderer and animation frames after the transition. When the system requests reduced motion, the portal uses a fade instead.

## Install and use

Search for **`dsh-codefall`** in dsh-market or in your desktop app's plugin manager. If the app provides an Add Plugin field, enter:

```text
dsh-codefall
```

Wait for installation to finish, enable the plugin, then **fully quit and restart the application**.

The default sequence is: **launch → digital rain → move the pointer, click, scroll, or press a key → portal opens → enter Harness**. The host UI must be ready before the portal transition begins.

> “On application startup only” means every fresh application launch, not once after installation. Restoring an application that stayed in the background does not replay the animation in this mode. Select the window-reopen option to replay it on supported desktop restores.

<details>
<summary>CLI and alternative installation sources</summary>

For a Web profile:

```bash
dsh plugin --profile web add dsh-codefall
```

If your desktop environment is managed through the CLI and its profile is actually named `desktop`:

```bash
dsh plugin --profile desktop add dsh-codefall
```

Prefer the app's own plugin manager when the desktop app provides one. The following alternatives are for CLI-managed environments; adjust the profile, path, and package filename to match your setup:

```bash
# Install from GitHub
dsh plugin --profile web add github:4444Hao/dsh-codefall

# Install a package you have already downloaded
dsh plugin --profile web add "D:\Downloads\dsh-codefall-0.2.0.tgz"
```

</details>

## Settings

Open the plugin's **“开机动画 codefall”** settings page. Its location depends on your Harness or desktop app version. The linked screenshot shows the current Chinese settings UI; the English labels in the table explain the options.

[View the Windows desktop settings screenshot](docs/images/settings-desktop.png).

It shows replay on window reopen, interaction dismissal, the Matrix portal, 90% density, ×1.20 speed, and Classic green at 120°. These are example settings, not the defaults.

| Setting | Options | Default |
| --- | --- | --- |
| Playback | Application startup only / Every window reopen | Application startup only |
| Dismissal | After interaction / Continue automatically after 3 seconds | After interaction |
| Exit transition | Matrix portal / Fade | Matrix portal |
| Rain density | Slider | 85% |
| Rain speed | Slider | ×1.00 |
| Quality | High / Standard / Economy | Standard |
| Appearance | Follow host / Dark / Light | Follow host |
| Green theme | On / Off | On |
| Green hue | Slider; Rain / Classic / Teal presets | Rain, 145° |

Saved playback and transition changes apply to subsequent playback without another restart. Green theme and hue changes take effect immediately. The 3-second automatic option still waits for the host UI to be ready.

### Light digital rain

[View light digital rain](docs/images/boot-light.png): dark green characters on a white background. The same renderer supports both appearances. Follow the host theme or choose an appearance in settings.

<details>
<summary>Green hue examples</summary>

[View the green hue comparison](docs/images/theme-hues.png): source blue, Classic green at 120°, Rain green at 145°, and Teal at 165°.

This is a color-mapping diagram, not a full application screenshot. The hue control changes the UI theme; it does not recolor the rain characters.

</details>

## Compatibility and notes

- Harness **0.2.0-rc.2 or newer** is recommended. Fully quit and restart after installing or updating the plugin.
- Replay on window restore depends on desktop visibility events. The current implementation targets desktop pages using the `dsh-app:` protocol; other desktop wrappers need separate verification.
- The Windows settings screenshot is linked above. The portal has been checked in a browser preview and offline tests. Real tray/minimize restore still needs the [manual acceptance checks](docs/PORTAL.md#实机验收), documented in Chinese. macOS and Linux have not been tested on actual devices; a fully covered window may also produce visibility events on macOS.
- Host versions and third-party plugins can define their own colors. Green-theme coverage depends on whether they use the host's theme variables.
- Disable or uninstall the plugin in the app's plugin manager to remove its theme layer. For CLI-managed environments, use `dsh plugin --profile web remove dsh-codefall`, replacing the profile as needed.

## Development and preview

See [Matrix portal and window-restore playback](docs/PORTAL.md) for implementation details and acceptance records, in Chinese. Open `preview/index.html` locally, select “就绪” (Ready), then “交互” (Interact) to preview the portal. This is an offline demonstration rather than an actual Harness window.

## License

[MIT](LICENSE)
