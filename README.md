# dotframe ⠿

**Browser-based GIF / video / image → Braille dot art converter.**

Point it at any `<img>`, animated GIF, `<video>`, or `<canvas>` and it renders
live, animated Unicode dot art (U+2800–U+28FF) straight into a `<pre>` element —
every frame, in real time.

**Zero dependencies. One file. ~4 KB gzipped.**

```
⠀⠀⢀⣤⣶⣿⣿⣶⣤⡀⠀⠀
⠀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣦⠀
⢸⣿⣿⡿⠋⠀⠀⠙⢿⣿⣿⡇
⢸⣿⣿⣷⣄⠀⠀⣠⣾⣿⣿⡇
⠀⠻⣿⣿⣿⣿⣿⣿⣿⣿⠟⠀
⠀⠀⠈⠛⠿⣿⣿⠿⠛⠁⠀⠀
```

## Live demo

**▶ [Try it live](https://dotframe.netlify.app/)** 
Or run it locally: open `index.html`, or serve the folder and drag in any
image, GIF, or video (there's a built-in plasma demo and a webcam mode too).

```bash
npx serve .   # then open http://localhost:3000
```

## Install

```bash
npm install dotframe
```

Zero dependencies — the whole engine is one UMD file. It also works with a
plain `<script>` tag or a CommonJS/AMD `require`, no build step required.

```js
import DotFrame from 'dotframe';
// or:  const DotFrame = require('dotframe');
// or:  <script src="dotframe.js"></script>  → window.DotFrame
```

## Usage

The whole API is three lines:

```html
<img id="src" src="clip.gif">
<pre id="out"></pre>

<script src="dotframe.js"></script>
<script>
  const df = new DotFrame('#src', '#out', { width: 100 });  // 1. point it
  df.start();                                                // 2. animate
  // df.snapshot();  → current frame as a plain string       // 3. read it
</script>
```

That's it. Still images render once; GIFs, videos, canvases, and the webcam
render continuously.

## API

### `new DotFrame(source, output, options?)`

- `source` — an `<img>`, `<video>`, or `<canvas>` element (or a CSS selector).
- `output` — the element that receives the text, ideally a `<pre>` (or a selector).
- `options` — see below.

### Methods

| Method | Description |
| --- | --- |
| `df.start()` | Start rendering. Still images render once; videos, canvases, and animated images render continuously. |
| `df.stop()` | Pause rendering. |
| `df.snapshot()` | Returns the most recent frame as a plain string — paste it anywhere monospace. |
| `df.setOptions(opts)` | Change any option live (width, threshold, dither, …). |
| `df.destroy()` | Stop and release decoded animation frames. |

### Options

| Option | Default | Description |
| --- | --- | --- |
| `width` | `0` (auto) | Output width in characters. Auto derives it from the source, capped at 120. Height follows the source aspect ratio. |
| `threshold` | `128` | Luminance cutoff 0–255, or `'auto'` to use each frame's mean luminance. |
| `dither` | `true` | Floyd–Steinberg error diffusion — much better gradients and detail. |
| `invert` | `false` | Flip light and dark (light-on-dark vs dark-on-light output). |
| `aspect` | `1.0` | Vertical stretch correction if your font's cell isn't ~1:2. |
| `color` | `false` | Color each character by its cell's average hue. Writes `<span>` runs via `innerHTML`; `snapshot()` still returns the plain string. Costs more per frame than mono. |
| `fps` | `30` | Frame rate cap. |
| `autoStyle` | `true` | Applies `monospace`, `line-height: 1`, `letter-spacing: 0` to the output element. |
| `onFrame` | `null` | `callback(frameString)` after every rendered frame. |

### Properties

`df.cols` / `df.rows` — output grid size in characters, available once
rendering starts. Handy for fitting the font size to a container.

## Exporting a looping GIF

`dotframe-export.js` is an optional zero-dependency add-on that records a
running DotFrame and encodes a looping animated GIF **entirely in the
browser** — no canvas text rendering, no server, no libraries. The dots are
rasterized straight into indexed pixels, so files are small, crisp, and loop
forever anywhere a GIF plays. The demo's **export gif** button uses it.

```html
<script src="dotframe.js"></script>
<script src="dotframe-export.js"></script>
<script>
  const blob = await DotFrameExport.gif(df, { scale: 2 });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dotframe.gif';
  a.click();
</script>
```

### `DotFrameExport.gif(df, options?)` → `Promise<Blob>`

| Option | Default | Description |
| --- | --- | --- |
| `duration` | one loop / `4000` | Milliseconds to record. Animated image sources default to exactly one full loop; video/canvas/webcam default to 4 s. |
| `scale` | `1` | Pixels per dot unit. Frame size is `cols×5 × rows×10` units. |
| `bg`, `fg` | `#000000`, `#c0c0c0` | Background and dot color (hex). In color mode, per-cell colors are used and `fg` is the fallback. |
| `loop` | `0` | GIF repeat count; `0` = loop forever. |

Still images (or a stopped DotFrame) export as a single-frame GIF. Duplicate
frames are deduplicated into longer delays automatically. There's also
`DotFrameExport.encode(frames, options)` if you want to build frames yourself.

## How it works

1. Each frame, the source is drawn onto a small offscreen canvas at
   `cols × 2` by `rows × 4` pixels — one pixel per Braille dot.
2. Pixels are converted to Rec. 709 luminance (alpha-weighted, so
   transparency reads as dark) and binarized, with optional Floyd–Steinberg
   dithering.
3. Every 2×4 pixel block maps to one Braille character: each of the 8 dots
   corresponds to one bit of the codepoint offset from U+2800, so the block
   packs directly into `String.fromCharCode(0x2800 + bits)`.
4. The assembled string replaces the `<pre>` content. At typical sizes this
   is well under a millisecond per frame.

## Notes & limitations

- **Animated GIFs** (and APNG / animated WebP) are decoded frame-by-frame via
  the [`ImageDecoder`](https://developer.mozilla.org/docs/Web/API/ImageDecoder)
  API (Chrome, Edge, recent Firefox). Where unavailable, they render as a
  static first frame — `<video>` works everywhere as a fallback.
- **Cross-origin sources** must be served with CORS headers (and `<img>`
  needs `crossOrigin="anonymous"`), otherwise the canvas is tainted and
  pixels can't be read. Local files via drag & drop always work.
- Output looks best in a font with proper Braille glyphs and `line-height: 1`
  — most system monospace fonts qualify.

## License

MIT © LoomingAI LLC
