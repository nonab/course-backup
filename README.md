# Course Backup

> **Content Portability & LMS Migration Tool for Creators & Educators**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Release](https://img.shields.io/github/v/release/nonab/course-backup?color=indigo&logo=github)](https://github.com/nonab/course-backup/releases/latest)
[![Electron](https://img.shields.io/badge/GUI-Electron-blue.svg)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Google Play](https://img.shields.io/badge/Course_Player-Google_Play-4285F4.svg?logo=google-play&logoColor=white)](https://play.google.com/store/apps/details?id=com.akademiapobierania.player&hl=pl)
[![Ko-fi](https://img.shields.io/badge/Support-Ko--fi-FF5E5B.svg?logo=ko-fi&logoColor=white)](https://ko-fi.com/nonab)

**Course Backup** is an open-source data backup and migration tool designed for course creators, educators, and training providers. It enables authors to archive, export, and migrate their educational content, course structure, lessons, and assets between different learning management systems (LMS) or into self-hosted archives.

The tool extracts the complete course structure into a clean JSON specification (`course.json`), prepares asset download manifests, and formats exported content for direct playback in the companion Course Player.

---

## Key Features

- **Modern Desktop App (Electron)**: A unified dark-mode GUI with real-time logs, live progress tracking, and interactive course selection cards.
- **Offline / From JSON Mode**: Download course videos and media directly from an existing `course.json` manifest without scraping or logging into the platform again.
- **CLI for Automation**: Full headless command-line interface for batch migrations and server pipelines.
- **Dynamic Platform Autoloader**: Modular platform adapters that dynamically detect and handle course platforms based on URLs and DOM signatures.
- **Multi-Cookie Authentication**: Switch between isolated session files (`--cookies=creator_session.json` or through the GUI file browser).
- **Course Structure Export (`course.json`)**: Preserves complete module $\rightarrow$ lesson $\rightarrow$ topic $\rightarrow$ asset relationships.
- **Companion Course Player**: Exported courses are designed to be imported directly into the official **[Course Player on Google Play](https://play.google.com/store/apps/details?id=com.akademiapobierania.player&hl=pl)** for seamless offline learning on mobile devices.

---

## Supported LMS Platforms

Out of the box, Course Backup includes modular adapters for major global LMS engines:

| Platform | Category | Detection / Notes |
|---|---|---|
| **LearnDash LMS** | WordPress LMS Plugin | Global standard WordPress LMS engine |
| **Tutor LMS** | WordPress LMS Plugin | Themeum WordPress course engine |
| **Sensei LMS** | WordPress LMS Plugin | Official LMS from Automattic (GPL) |
| **WP Courseware** | WordPress LMS Plugin | Structured WordPress learning engine |
| **Teachable** | Cloud SaaS | Global creator course platform |
| **Kajabi** | Cloud SaaS | Creator community & course suite |
| **Skool** | Cloud SaaS | Community-driven classroom platform |
| **Systeme.io** | Cloud SaaS | Marketing & course hosting platform |

Need to support another LMS? You can create a new adapter in minutes — see [PLUGINS.md](PLUGINS.md), or request a dedicated platform adapter:  
👉 **[Request a Custom Platform Adapter on Ko-fi](https://ko-fi.com/nonab/commissions?commissionAlias=df83097268#buyShopCommissionModal)**

---

## Quick Start

### Option 1: Desktop App (Recommended — No Node.js required)

> [!TIP]
> The easiest way to get started. You do **not** need Node.js, Git, or npm installed.

1. Download the latest installer for Windows from **[GitHub Releases](https://github.com/nonab/course-backup/releases/latest)** (`Course-Backup-*.exe`).
2. Run the installer or standalone executable to launch the GUI.
3. *(Optional)* For maximum download speeds and media stream processing, install `yt-dlp` and `ffmpeg`:
   ```powershell
   winget install yt-dlp Gyan.FFmpeg
   ```
   *(Alternatively, place portable `yt-dlp.exe` and `ffmpeg.exe` into a `bin/` folder next to the app).*

---

### Option 2: Run from Source / CLI (Developers & Automation)

#### Prerequisites
- [Node.js](https://nodejs.org/) (v18.0.0 or higher) & npm (v9.0.0 or higher)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) & [ffmpeg](https://ffmpeg.org/):
  - Fast install on Windows: `winget install yt-dlp Gyan.FFmpeg`
  - Or portable: place `yt-dlp.exe` and `ffmpeg.exe` into the `bin/` folder.
- Windows 10/11 (for Desktop GUI & automated `.bat` downloads; CLI also runs cross-platform)

#### Installation
```bash
git clone https://github.com/nonab/course-backup.git
cd course-backup
npm install
```

#### Running the Desktop App (GUI)
```bash
npm start
```

---

### Using the Desktop App
The desktop interface lets you:
1. Enter your LMS / platform URL (or switch to **From JSON** mode to download media from existing manifests).
2. Provide your creator credentials or browse for an exported `cookies.json` session file.
3. Select an output export directory.
4. Choose backup mode (**JSON Only**, **Full Backup**, or **From JSON**).
5. Interactively select which courses to export.

---

## Command Line Interface (CLI)

For headless execution or script automation:

```bash
# Basic JSON extraction
npm run cli -- https://your-platform.com user@example.com password123

# Full export with custom output directory and cookies file
npm run cli -- https://your-platform.com --cookies=session.json --output-dir=./exports all

# Non-headless mode (visible browser window for interactive CAPTCHA / 2FA)
npm run cli -- https://your-platform.com --headful
```

### CLI Arguments & Flags
```
node src/cli/cli.js <url> [username] [password] [mode] [flags]

Modes:
  json                  Extract course structure and save course.json (default)
  all                   Extract structure and download media assets
  files                 Extract structure and download course materials

Flags:
  --cookies=<path>      Path to session cookies JSON file
  --output-dir=<path>   Destination directory (defaults to ./output)
  --course=<ids>        Preselect course IDs (e.g. 1 or 1,2 or 0 for all)
  --audio-only          Generate audio-only media tasks
  --headful             Display visible browser window
```

---

## Project Architecture

```
course-backup/
├── src/
│   ├── core/
│   │   ├── engine.js          # Core ScraperEngine (EventEmitter lifecycle)
│   │   └── jsonToBat.js       # Download manifest and batch builder
│   ├── platforms/             # Dynamic Platform Autoloader
│   │   ├── index.js           # PlatformRegistry singleton
│   │   ├── templatePlatformFunctions.js # Standard boilerplate for new platforms
│   │   └── platform*.js       # Modular platform adapters
│   ├── desktop/               # Electron Application Core
│   │   ├── main.js            # Electron main process (native engine orchestration)
│   │   ├── preload.js         # Secure context bridge
│   │   └── index.html         # Tailwind dark-mode user interface
│   └── cli/
│       └── cli.js             # Terminal CLI entry point
├── package.json               # Unified dependencies and build scripts
├── README.md                  # Documentation
└── PLUGINS.md                 # Adapter development guide
```

---

## Companion Course Player

Exported course packages are fully compatible with the official offline viewer on Android:

[![Get it on Google Play](https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png)](https://play.google.com/store/apps/details?id=com.akademiapobierania.player&hl=pl)

**[Download Course Player on Google Play](https://play.google.com/store/apps/details?id=com.akademiapobierania.player&hl=pl)**

---

## Support the Project & Custom Adapters

If you find Course Backup useful for your workflow, you can support its ongoing maintenance or request dedicated platform integrations:

- ☕ **Support on Ko-fi**: [![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/nonab)
- 🚀 **Request Custom LMS Adapter**: [![Request on Ko-fi](https://img.shields.io/badge/Ko--fi-Request%20Platform%20Adapter-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/nonab/commissions?commissionAlias=df83097268#buyShopCommissionModal)

---

## Contributing

Contributions are welcome! Please feel free to submit issues, add support for more LMS engines, or suggest improvements. For creating platform adapters, refer to [PLUGINS.md](PLUGINS.md).

---

## Legal & Compliance Notice

This tool is provided strictly for educational purposes, content portability (GDPR Art. 20), and migration of authorized learning content by content owners and lawful licensees. Users are responsible for ensuring compliance with the terms of service and applicable intellectual property laws of their respective service providers.

---

## License

This project is licensed under the [MIT License](LICENSE).
