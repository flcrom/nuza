# nuza

**nuza** is a lightning-fast, privacy-first, and fully open-source alternative to Obsidian. Built natively with Tauri and React, it delivers a deeply integrated desktop experience that stays out of your way.

[<img src="https://nuza-cdn.puang.in/Snapzy_2026-10-01_16-15-06_469.png" alt="Watch the nuza intro video — a note rendering as it is written, the vault's file tree beside it, open tabs across the top and the Vim mode indicator in the status bar" width="100%" />](https://nuza-cdn.puang.in/nuza-intro-v3.mp4)
<i>(click on the image above for a surprise)</i>

Featuring a beautifully minimalist UI, native Vim keybindings out of the box, and a strictly local file-system approach, **nuza** is designed for developers and writers who demand absolute control over their notes without the bloat. Its optional AI panel uses an agent already on your computer (Claude Code, Codex, OpenCode or your own) on your own plan: nuza has no server and no account, the agent sees only what nuza sends it, and on macOS and Linux it is fenced off from your files. See [AI in nuza](docs/ai.md).

## Local Setup

1. Clone the repository and navigate into the project directory.

2. Install dependencies:

   ```sh
   bun install
   ```

3. Run the development server:
   ```sh
   bun run tauri dev
   ```

## Build

To build the native application for your operating system:

```sh
bun run tauri build
```

## Contributing

If you're interested in contributing to nuza, please read our [contributing docs](CONTRIBUTING.md) before submitting a pull request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
