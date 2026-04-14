# Kumbukum Browser Extension

Save URLs and notes to [Kumbukum](https://kumbukum.com) from any page. Your personal knowledge base, one click away.

## Features

- **Save URL** — One-click save of the current page URL to your Kumbukum project
- **Write a Note** — Markdown editor in the popup to create notes linked to what you're browsing
- **Project Selection** — Choose which Kumbukum project to save into
- **Self-hosted Support** — Works with any Kumbukum instance (configurable URL)

## Setup

### Prerequisites

- Node.js >= 18
- A Kumbukum account with a Personal Access Token

### Install Dependencies

```bash
npm install
```

### Build

**Chrome:**

```bash
npm run build
```

Output in `build/`. Load as unpacked extension in `chrome://extensions/`.

**Firefox:**

```bash
npm run build:firefox
```

Output in `build-firefox/`. Load as temporary add-on in `about:debugging`.

### Development

```bash
npm run watch          # Chrome, auto-rebuild on changes
npm run watch:firefox  # Firefox, auto-rebuild on changes
```

### Package for Distribution

```bash
npm run build          # Creates build.zip for Chrome Web Store
npm run build:firefox  # Creates build-firefox.zip for Firefox Add-ons
```

## Configuration

1. Click the Kumbukum extension icon → **Open Settings** (or right-click → Options)
2. Enter your **Instance URL** (e.g. `https://app.kumbukum.com`)
3. Enter your **Personal Access Token** (create one in Kumbukum under Settings → Access Tokens)
4. Click **Verify Connection**
5. Select a **Project** and click **Save Settings**

## Usage

1. Navigate to any web page
2. Click the Kumbukum extension icon
3. Click **Save URL** to save the page link to Kumbukum
4. Optionally write a note using the markdown editor and click **Save Note**

## License

See [LICENSE](LICENSE).
