# Kumbukum Browser Extension

> Capture context from any page.  
> Save URLs and notes into Kumbukum without breaking your flow.

The Kumbukum Browser Extension is the fastest way to send what you are reading into your shared memory layer. Save a page URL, write a markdown note, or do both at once and link them together inside Kumbukum.

[Website](https://kumbukum.com) · [Cloud](https://app.kumbukum.com) · [Docs](https://app.kumbukum.com/docs/) · [Self-Hosted Guide](https://app.kumbukum.com/docs/selfhosted/)

## Why this extension exists

When useful context lives in tabs, it gets lost fast.

This extension lets you capture what matters while you are already on the page:

- **Save the current URL** directly into Kumbukum
- **Write a markdown note** alongside what you are browsing
- **Save URL + note together** and automatically link them
- **Choose the target project** so captured context lands in the right place
- **Switch between accounts** for Cloud, self-hosted, or multiple workspaces

## What it does

- **Current page capture** — grabs the active tab URL and page title
- **Markdown note editor** — write quick notes inside the popup with formatting and preview
- **Automatic linking** — when you save both a URL and note, the extension links them in Kumbukum
- **Multi-account support** — configure multiple Kumbukum accounts and switch from the popup
- **Cloud + self-hosted support** — works with `app.kumbukum.com` or your own Kumbukum instance
- **Project-aware capture** — verify connection, load projects, and choose where new items are stored

## How it works

1. Configure a Kumbukum account in the extension settings
2. Verify the connection with your personal access token
3. Pick the project that should receive captured items
4. On any page, open the popup and save the URL, a note, or both
5. If you save both, the extension creates both records and links them automatically

## Supported browsers

- **Chrome / Chromium-based browsers** via Manifest V3 build
- **Firefox** via dedicated Firefox build

## Getting started

### Prerequisites

- Node.js >= 18
- npm
- A Kumbukum account or self-hosted instance
- A personal access token from **Settings → Tokens**

### Install dependencies

```bash
npm install
```

### Build for Chrome

```bash
npm run build
```

This outputs:

- `build/` — unpacked Chrome extension
- `build.zip` — packaged archive for distribution

Load `build/` as an unpacked extension in `chrome://extensions/`.

### Build for Firefox

```bash
npm run build:firefox
```

This outputs:

- `build-firefox/` — unpacked Firefox extension
- `build-firefox.zip` — packaged archive for distribution

Load `build-firefox/` as a temporary add-on in `about:debugging`.

### Development

```bash
npm run watch
npm run watch:firefox
```

### Firefox testing helpers

```bash
npm run start:firefox
npm run lint:firefox
```

## Configuration

The extension opens the options page automatically on first install.

To configure an account manually:

1. Open the extension settings / options page
2. Add an account name so you can tell workspaces apart
3. Enter your **Instance URL**
	- Cloud: `https://app.kumbukum.com`
	- Self-hosted: `https://your-instance.com`
4. Enter your **Personal Access Token**
5. Click **Verify Connection**
6. Select a project from the loaded project list
7. Save the account

You can add multiple accounts and switch the active one from the popup.

## Usage

### Save URL only

1. Open any page
2. Click the Kumbukum extension icon
3. Click **Save URL Only**

### Save note only

1. Open the popup
2. Write a markdown note
3. Optionally add a note title
4. Click **Save Note Only**

### Save URL and note together

1. Open the popup on the page you want to capture
2. Write your note in markdown
3. Click **Save URL & Note**

The extension will:

- save the current page as a URL
- save the note to the selected Kumbukum project
- create a link between them when both saves succeed

## Tech notes

- Uses `webextension-polyfill` for cross-browser compatibility
- Uses `EasyMDE` for the popup markdown editor
- Uses `marked` to convert markdown to HTML before saving notes
- Uses Webpack to build browser-specific bundles and manifests

## License

See [LICENSE](LICENSE).
