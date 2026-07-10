/*!
 * dotframe — real-time Braille dot art engine for the browser.
 * Converts <img>, <canvas>, animated GIF, or <video> into animated
 * Braille Unicode text (U+2800–U+28FF) rendered into a <pre> element.
 *
 * Zero dependencies. MIT License.
 *
 *   const df = new DotFrame(sourceElement, outputElement, options);
 *   df.start();      // begin animation
 *   df.stop();       // pause
 *   df.snapshot();   // current frame as a string
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define(factory);
  else global.DotFrame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Braille dot bit values by [row][col] within a 2x4 cell.
  // U+2800 + bits = the character. Dots 1-8 per the Unicode spec.
  var DOT_BITS = [
    [0x01, 0x08], // row 0: dot 1, dot 4
    [0x02, 0x10], // row 1: dot 2, dot 5
    [0x04, 0x20], // row 2: dot 3, dot 6
    [0x40, 0x80]  // row 3: dot 7, dot 8
  ];

  var DEFAULTS = {
    width: 0,        // output width in characters; 0 = auto from source (max 120)
    threshold: 128,  // 0-255 luminance cutoff, or 'auto' (mean luminance per frame)
    dither: true,    // Floyd-Steinberg error diffusion
    invert: false,   // flip light/dark
    aspect: 1.0,     // vertical stretch correction (rows *= aspect)
    color: false,    // per-character color from the source (writes <span>s via innerHTML)
    fps: 30,         // max frames per second
    autoStyle: true, // apply monospace/line-height styles to the output element
    onFrame: null    // callback(frameString) after each rendered frame
  };

  function resolveEl(el, what) {
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el || !el.nodeType) throw new Error('DotFrame: ' + what + ' element not found');
    return el;
  }

  function once(el, ev) {
    return new Promise(function (res, rej) {
      el.addEventListener(ev, res, { once: true });
      el.addEventListener('error', function () { rej(new Error('DotFrame: failed to load source')); }, { once: true });
    });
  }

  // Sniff an image container format from its magic bytes (for ImageDecoder).
  function sniffType(buf) {
    var b = new Uint8Array(buf.slice(0, 16));
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'; // covers APNG
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return null;
  }

  // Expand a 12-bit quantized color key back to a CSS color span.
  // key < 0 means "no color seen yet" (a run of blank cells): plain text.
  function colorSpan(key, str) {
    if (key < 0) return str;
    var r = ((key >> 8) & 15) * 17;
    var g = ((key >> 4) & 15) * 17;
    var b = (key & 15) * 17;
    return '<span style="color:rgb(' + r + ',' + g + ',' + b + ')">' + str + '</span>';
  }

  function DotFrame(source, output, options) {
    this.source = resolveEl(source, 'source');
    this.output = resolveEl(output, 'output');
    this.options = {};
    for (var k in DEFAULTS) this.options[k] = DEFAULTS[k];
    if (options) for (var k2 in options) if (options[k2] !== undefined) this.options[k2] = options[k2];

    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._running = false;
    this._raf = 0;
    this._lastT = 0;
    this._lastStr = '';
    this._ready = false;
    this._static = false;   // true when the source is a still image (render once)
    this._frames = null;    // decoded animation frames: [{bitmap, duration(ms)}]
    this._frameStart = 0;   // wall-clock start for animation frame timing
    this._totalDuration = 0;
    this._warned = false;
    this.cols = 0;
    this.rows = 0;

    if (this.options.autoStyle) {
      var s = this.output.style;
      s.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      s.lineHeight = '1';
      s.letterSpacing = '0';
      s.whiteSpace = 'pre';
    }
  }

  DotFrame.prototype.start = function () {
    if (this._running) return this;
    this._running = true;
    var self = this;
    this._ensureReady().then(function () {
      if (self._running) {
        self._frameStart = performance.now();
        self._tick(performance.now());
      }
    }).catch(function (err) {
      self._running = false;
      console.error(err);
    });
    return this;
  };

  DotFrame.prototype.stop = function () {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    return this;
  };

  DotFrame.prototype.snapshot = function () {
    return this._lastStr;
  };

  // Structured view of the last rendered frame (used by dotframe-export).
  // `colors` is a live Int16Array of per-cell 12-bit color keys when color
  // mode is on, else null — copy it if you need to keep it across frames.
  DotFrame.prototype.frameData = function () {
    return { text: this._lastStr, cols: this.cols, rows: this.rows, colors: this._lastKeys };
  };

  DotFrame.prototype.setOptions = function (opts) {
    var needGrid = false;
    for (var k in opts) {
      if (opts[k] !== undefined && k in this.options) {
        if ((k === 'width' || k === 'aspect') && opts[k] !== this.options[k]) needGrid = true;
        this.options[k] = opts[k];
      }
    }
    if (this._ready) {
      if (needGrid) this._computeGrid();
      // Re-render still images immediately so option changes are visible.
      if (this._static && this._drawable) this._render(this._drawable);
    }
    return this;
  };

  DotFrame.prototype.destroy = function () {
    this.stop();
    if (this._frames) {
      for (var i = 0; i < this._frames.length; i++) this._frames[i].bitmap.close();
      this._frames = null;
    }
    this._drawable = null;
    return this;
  };

  // --- internals -----------------------------------------------------------

  DotFrame.prototype._ensureReady = function () {
    var self = this;
    if (this._ready) return Promise.resolve();
    if (this._readying) return this._readying;

    var s = this.source;
    var p;
    if (typeof HTMLImageElement !== 'undefined' && s instanceof HTMLImageElement) {
      p = (s.complete && s.naturalWidth ? Promise.resolve() : once(s, 'load')).then(function () {
        self._srcW = s.naturalWidth;
        self._srcH = s.naturalHeight;
        return self._decodeAnimated(s);
      });
    } else if (typeof HTMLVideoElement !== 'undefined' && s instanceof HTMLVideoElement) {
      p = (s.readyState >= 1 ? Promise.resolve() : once(s, 'loadedmetadata')).then(function () {
        self._srcW = s.videoWidth;
        self._srcH = s.videoHeight;
      });
    } else if (typeof HTMLCanvasElement !== 'undefined' && s instanceof HTMLCanvasElement) {
      self._srcW = s.width;
      self._srcH = s.height;
      p = Promise.resolve();
    } else {
      return Promise.reject(new Error('DotFrame: source must be an <img>, <video>, or <canvas>'));
    }

    this._readying = p.then(function () {
      if (!self._srcW || !self._srcH) throw new Error('DotFrame: source has no dimensions');
      self._computeGrid();
      self._ready = true;
    });
    return this._readying;
  };

  // For <img>: try to decode all animation frames (GIF/APNG/animated WebP)
  // via the ImageDecoder API. Falls back to a static first frame where the
  // API is unavailable (drawImage on an animated GIF only yields frame 1).
  DotFrame.prototype._decodeAnimated = function (img) {
    var self = this;
    this._static = true;
    if (typeof ImageDecoder === 'undefined' || !img.src) return Promise.resolve();

    return fetch(img.src).then(function (res) {
      return res.arrayBuffer().then(function (buf) {
        var type = sniffType(buf) || res.headers.get('content-type');
        if (!type || type.indexOf('image/') !== 0) return;
        return ImageDecoder.isTypeSupported(type).then(function (ok) {
          if (!ok) return;
          var decoder = new ImageDecoder({ data: buf, type: type });
          return decoder.tracks.ready.then(function () {
            var track = decoder.tracks.selectedTrack;
            if (!track || track.frameCount <= 1) { decoder.close(); return; }
            var frames = [];
            var chain = Promise.resolve();
            for (var i = 0; i < track.frameCount; i++) {
              (function (idx) {
                chain = chain.then(function () {
                  return decoder.decode({ frameIndex: idx }).then(function (r) {
                    var durMs = (r.image.duration || 100000) / 1000; // µs → ms
                    return createImageBitmap(r.image).then(function (bmp) {
                      r.image.close();
                      frames.push({ bitmap: bmp, duration: durMs, until: 0 });
                    });
                  });
                });
              })(i);
            }
            return chain.then(function () {
              decoder.close();
              var t = 0;
              for (var j = 0; j < frames.length; j++) { t += frames[j].duration; frames[j].until = t; }
              self._frames = frames;
              self._totalDuration = t;
              self._static = false;
            });
          });
        });
      });
    }).catch(function () { /* cross-origin or decode failure: stay static */ });
  };

  DotFrame.prototype._computeGrid = function () {
    var gw = this.options.width > 0
      ? Math.round(this.options.width)
      : Math.min(120, Math.max(1, Math.round(this._srcW / 2)));
    var pxAspect = this._srcH / this._srcW;
    var gh = Math.max(1, Math.round((gw * 2 * pxAspect / 4) * this.options.aspect));
    this.cols = gw;
    this.rows = gh;
    this._canvas.width = gw * 2;
    this._canvas.height = gh * 4;
    this._lum = new Float32Array(gw * 2 * gh * 4);
  };

  DotFrame.prototype._tick = function (t) {
    if (!this._running) return;
    var self = this;
    var interval = 1000 / Math.max(1, this.options.fps);

    if (t - this._lastT >= interval) {
      this._lastT = t - ((t - this._lastT) % interval);
      var drawable = this.source;
      if (this._frames) drawable = this._pickAnimationFrame(t).bitmap;
      this._render(drawable);
      if (this._static) return; // still image: one frame is enough
    }
    this._raf = requestAnimationFrame(function (ts) { self._tick(ts); });
  };

  DotFrame.prototype._pickAnimationFrame = function (t) {
    var pos = (t - this._frameStart) % this._totalDuration;
    var frames = this._frames;
    for (var i = 0; i < frames.length; i++) {
      if (pos < frames[i].until) return frames[i];
    }
    return frames[frames.length - 1];
  };

  DotFrame.prototype._render = function (drawable) {
    this._drawable = drawable;
    var o = this.options;
    var w = this._canvas.width, h = this._canvas.height;
    var ctx = this._ctx;

    ctx.clearRect(0, 0, w, h);
    try {
      ctx.drawImage(drawable, 0, 0, w, h);
    } catch (e) {
      return; // source not ready this frame (e.g. video seeking)
    }

    var data;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch (e) {
      if (!this._warned) {
        this._warned = true;
        console.error('DotFrame: canvas is tainted by cross-origin data. ' +
          'Serve the source with CORS headers and set crossOrigin="anonymous".');
      }
      this.stop();
      return;
    }

    // Luminance (Rec. 709), alpha-weighted so transparency reads as dark.
    var lum = this._lum;
    for (var i = 0, j = 0; i < lum.length; i++, j += 4) {
      lum[i] = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) * (data[j + 3] / 255);
    }

    var threshold = o.threshold;
    if (threshold === 'auto') {
      var sum = 0;
      for (var m = 0; m < lum.length; m++) sum += lum[m];
      threshold = sum / lum.length;
    }

    // Binarize, with optional Floyd-Steinberg dithering.
    if (o.dither) {
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var idx = y * w + x;
          var old = lum[idx];
          var val = old >= threshold ? 255 : 0;
          lum[idx] = val;
          var err = old - val;
          if (x + 1 < w) lum[idx + 1] += err * 7 / 16;
          if (y + 1 < h) {
            if (x > 0) lum[idx + w - 1] += err * 3 / 16;
            lum[idx + w] += err * 5 / 16;
            if (x + 1 < w) lum[idx + w + 1] += err * 1 / 16;
          }
        }
      }
      threshold = 128; // after dithering, values are 0 or 255
    }

    // Pack 2x4 blocks into Braille characters.
    var gw = this.cols, gh = this.rows;
    var invert = o.invert;
    var useColor = !!o.color;
    var out = new Array(gh);
    var htmlRows = useColor ? new Array(gh) : null;
    var codes = new Array(gw);
    if (useColor) {
      if (!this._lastKeys || this._lastKeys.length !== gw * gh) this._lastKeys = new Int16Array(gw * gh);
    } else {
      this._lastKeys = null;
    }
    var keys = this._lastKeys;
    for (var cy = 0; cy < gh; cy++) {
      var runKey = -1, runStr = '', rowHtml = '';
      for (var cx = 0; cx < gw; cx++) {
        var bits = 0;
        var baseX = cx * 2, baseY = cy * 4;
        var r = 0, g = 0, b = 0;
        for (var ry = 0; ry < 4; ry++) {
          var row = (baseY + ry) * w + baseX;
          if ((lum[row] >= threshold) !== invert) bits |= DOT_BITS[ry][0];
          if ((lum[row + 1] >= threshold) !== invert) bits |= DOT_BITS[ry][1];
          if (useColor) {
            var pI = row * 4;
            r += data[pI] + data[pI + 4];
            g += data[pI + 1] + data[pI + 5];
            b += data[pI + 2] + data[pI + 6];
          }
        }
        codes[cx] = 0x2800 + bits;
        if (useColor) {
          // Blank cells show no dots, so they extend the current color run.
          var key = runKey;
          if (bits !== 0) {
            r >>= 3; g >>= 3; b >>= 3; // average of the 8 sampled pixels
            // Normalize brightness into hue: dot density already carries
            // luminance, so push the color to full value (terminal-art look).
            var v = Math.max(r, g, b);
            if (v > 0) {
              r = Math.round(r * 255 / v);
              g = Math.round(g * 255 / v);
              b = Math.round(b * 255 / v);
            }
            // Quantize to 16 levels/channel so adjacent cells merge into runs.
            key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          }
          keys[cy * gw + cx] = key;
          var ch = String.fromCharCode(0x2800 + bits);
          if (key !== runKey) {
            if (runStr) rowHtml += colorSpan(runKey, runStr);
            runKey = key;
            runStr = ch;
          } else {
            runStr += ch;
          }
        }
      }
      out[cy] = String.fromCharCode.apply(null, codes);
      if (useColor) {
        if (runStr) rowHtml += colorSpan(runKey, runStr);
        htmlRows[cy] = rowHtml;
      }
    }

    this._lastStr = out.join('\n');
    if (useColor) this.output.innerHTML = htmlRows.join('\n');
    else this.output.textContent = this._lastStr;
    if (typeof o.onFrame === 'function') o.onFrame(this._lastStr);
  };

  DotFrame.version = '0.1.0';
  return DotFrame;
});
