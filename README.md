# Lasso

A PDF and image reader that sits beside the chat in Claude Code. Circle a region or select text, and send it to Claude with your question. When the file changes on disk (a LaTeX rebuild, a re-exported figure), Lasso offers a refresh instead of reloading under you.

- **Smooth PDFs**: pdf.js's own viewer, rendering only the pages in view, with crisp zoom (Ctrl + scroll zooms around the pointer), search (Ctrl F) and full CJK font support.
- **Images too**: PNG, JPG, GIF, WebP, BMP, SVG and AVIF, with zoom and pan.
- **Circle and ask**: press `L`, draw around a formula, figure or paragraph (hold Shift for a rectangle), type a question, press Enter. Claude gets a sharp screenshot of the region (re-rendered at print resolution, or cropped from the image's own pixels), the text inside it, the page and the file.
- **Add or send**: **Send** asks Claude now; **Add** keeps the clip as a chip above the prompt, to go with your next message. Collect several and send them together.
- **Change banner**: a non-intrusive "file changed, refresh?" bar; refreshing keeps your page and scroll position.
- **Default viewer**: when you ask Claude to open or show a local PDF or image, or @-mention one, it opens in Lasso.
- **Follows Claude's language**: Claude Code's `language` setting, otherwise the language you write in (Chinese and English).

## Install

At the prompt of a terminal session:

```
/plugin install lasso --marketplace YukHin/lasso
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install lasso --marketplace YukHin/lasso
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `YukHin/lasso`, then Add plugin.

Lasso needs **Node.js 18 or newer** on your PATH. On first use it installs `pdfjs-dist` (the pdf.js build, about 30 MB) from npm into `~/.claude/lasso/vendor`.

## Use

| | |
| --- | --- |
| `/lasso <file.pdf or image> [page]` | open a file (`@file.pdf` works too); `/lasso` alone reopens the last one |
| `/lasso clear` | drop the clips waiting above the prompt |
| `/lasso shell` | Windows: add "Open with Lasso" to Explorer's right-click menu and "Open with" list (`/lasso unshell` removes it) |

In the reader: `L` circle · `V` text / pan · `Enter` send · `Ctrl+Enter` add only · `R` refresh after a change · `Ctrl +/-/0` zoom.

In the Claude Code desktop app the reader opens in the built-in browser pane beside the chat (Claude opens it there, so each `/lasso` adds a short turn). Elsewhere it opens in your browser.

## How it works

The mod starts a small local server (bound to `127.0.0.1`, every API call carrying a per-session token) that serves the reader, polls each opened file for changes, and hands clips back to the mod. Clip screenshots are saved to `~/.claude/lasso/clips` and removed after 14 days. Nothing leaves your machine except what you send to Claude.

To be its default viewer, Lasso adds a short note to the system prompt and turns away Claude's other ways of showing a *local* PDF or image (the PDF viewer connector, a `file://` page in the browser pane) with a pointer to Lasso. Remote URLs are left alone.

`/lasso shell` writes only under `HKCU\Software\Classes` (your user, no admin rights): a "Show more options" entry for PDFs and images, and Lasso in the "Open with" list.

## License

MIT
