# Image Batch Studio (website)

Paste a whole video script and get one numbered image per scene, generated in a batch. Images are named in scene order (Image 001, Image 002 and so on) and can be downloaded as one ZIP.

## Engines

| Engine | What you need | Notes |
|---|---|---|
| Google Flow | The **Image Batch Studio Helper** extension, and a Flow project open in another tab | Nano Banana on your own Google account. Free while Flow shows 0 credits. One image at a time. Saves Flow's original-size image. |
| Gemini API | A Gemini API key from aistudio.google.com (Settings) | Nano Banana models. Google's free tier often allows no image requests, so this usually needs billing. Sends character and style reference images. |
| Pollinations | Nothing, or a free key from enter.pollinations.ai (Settings) | Without a key: one smaller image about every 45 seconds. With a key: full size, more models, up to 5 images at once. |

If Flow or Gemini hits its limit during a batch, the batch can continue automatically with Pollinations (a switch on the New batch page). You can also change the engine for the remaining scenes from the Queue page while a batch is paused.

## Features

- Paste one prompt per line, `1.` `2.` numbering, or `Scene 1:` headings for multi-line prompts. Import a TXT file. Try 10 samples, or load a 1,000-line demo.
- Character and style consistency text added to every prompt, with optional reference images (sent to Gemini).
- Start from any scene number, parallel images, Preview first image, Pause, Stop, Resume.
- Queue with live progress, Waiting/Generating/Done/Failed filters, Retry and Skip per scene, Retry failed, and an exported CSV report.
- Gallery shown as a contact sheet, a full-size viewer with Previous/Next, Download image and Make again.
- Download all as ZIP, in scene order. Optionally save every image into a folder on your computer as it finishes (Chrome and Edge).
- Projects history with cover image, progress and delete. Everything is stored in the browser (IndexedDB). Nothing is sent to any server except the image engine you choose.

Keep the tab open while a batch runs. You can switch to other tabs. If the page is closed, the batch pauses and you can resume it later.

## Put it online

The site is plain HTML, CSS and JavaScript with no build step. Upload the whole `website` folder to any static host:

- **Netlify**: drag the folder onto app.netlify.com/drop.
- **Vercel**: `vercel deploy` inside the folder, or import it from GitHub.
- **GitHub Pages**: push the folder to a repository and enable Pages.
- **Cloudflare Pages**: create a project and upload the folder.

To try it on your own computer, run a local server in the folder, for example `npx serve .` or `python -m http.server 8080`, and open http://localhost:8080. Opening `index.html` directly from disk will not work, because browsers block modules on `file://`.

## The Flow helper extension

Websites cannot control another site, so Google Flow needs the small helper extension in the `helper-extension` folder.

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `helper-extension` folder.
3. Open Google Flow, sign in and open a project.
4. Reload the website. The status at the bottom of the sidebar turns green.

The helper runs on these addresses: localhost, 127.0.0.1, `*.netlify.app`, `*.vercel.app`, `*.github.io` and `*.pages.dev`. **If you use your own domain**, add it to `content_scripts.matches` in `helper-extension/manifest.json`, for example `"https://images.yourdomain.com/*"`, then click Reload on the Extensions page.

The helper only acts when the page carries the Image Batch Studio marker, generates one image at a time, and checks that Flow quotes 0 credits before every image.
