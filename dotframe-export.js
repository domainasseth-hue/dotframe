/*!
 * dotframe-export — records a DotFrame instance and encodes a looping
 * animated GIF, entirely in the browser. Zero dependencies. MIT License.
 *
 *   DotFrameExport.gif(df, options).then(blob => ...download...)
 *
 * The dots are rasterized directly into indexed pixels (no font rendering),
 * so the output is crisp, small, and identical everywhere it's viewed.
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define(factory);
  else global.DotFrameExport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Braille bit n → [col, row] within the 2x4 cell (bits 0-7 = dots 1-8).
  var DOT_POS = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]];
  // Dot offsets inside a character cell, in units. Cell = 5x10 units, so the
  // rendered geometry matches a monospace Braille glyph (~1:2 cell ratio).
  var DOT_X = [1, 3];
  var DOT_Y = [1, 3, 5, 7];
  var CELL_W = 5, CELL_H = 10;

  function hexToRGB(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
    var n = parseInt(m ? m[1] : 'c0c0c0', 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Color keys are DotFrame's 12-bit quantized colors (4 bits/channel).
  // `shift` coarsens them further when a recording uses too many colors.
  function reduceKey(key, shift) {
    var r = ((key >> 8) & 15) >> shift;
    var g = ((key >> 4) & 15) >> shift;
    var b = (key & 15) >> shift;
    return (r << 8) | (g << 4) | b;
  }

  function reducedToRGB(key, shift) {
    var levels = 15 >> shift;
    return [
      Math.round((((key >> 8) & 15)) * 255 / levels),
      Math.round((((key >> 4) & 15)) * 255 / levels),
      Math.round((key & 15) * 255 / levels)
    ];
  }

  // --- rasterizer ------------------------------------------------------------

  function rasterize(frame, scale, W, H, colorIndex) {
    var buf = new Uint8Array(W * H); // index 0 = background
    var lines = frame.text.split('\n');
    for (var y = 0; y < lines.length; y++) {
      var line = lines[y];
      for (var x = 0; x < line.length; x++) {
        var bits = line.charCodeAt(x) - 0x2800;
        if (bits <= 0 || bits > 255) continue;
        var idx = 1; // foreground
        if (frame.colors && colorIndex) {
          var key = frame.colors[y * frame.cols + x];
          if (key >= 0) idx = colorIndex(key);
        }
        for (var b = 0; b < 8; b++) {
          if (!(bits & (1 << b))) continue;
          var px = (x * CELL_W + DOT_X[DOT_POS[b][0]]) * scale;
          var py = (y * CELL_H + DOT_Y[DOT_POS[b][1]]) * scale;
          for (var dy = 0; dy < scale; dy++) {
            var off = (py + dy) * W + px;
            for (var dx = 0; dx < scale; dx++) buf[off + dx] = idx;
          }
        }
      }
    }
    return buf;
  }

  // --- GIF89a encoder ----------------------------------------------------------

  function lzw(minCodeSize, indices) {
    var out = [];
    var acc = 0, nbits = 0;
    var clearCode = 1 << minCodeSize;
    var eoiCode = clearCode + 1;
    var codeSize = minCodeSize + 1;
    var nextCode = eoiCode + 1;
    var dict = new Map();

    function emit(code) {
      acc |= code << nbits;
      nbits += codeSize;
      while (nbits >= 8) {
        out.push(acc & 255);
        acc >>= 8;
        nbits -= 8;
      }
    }

    emit(clearCode);
    var prev = indices[0];
    for (var i = 1; i < indices.length; i++) {
      var k = indices[i];
      var key = (prev << 8) | k;
      var code = dict.get(key);
      if (code !== undefined) {
        prev = code;
        continue;
      }
      emit(prev);
      if (nextCode === 4096) {
        emit(clearCode);
        codeSize = minCodeSize + 1;
        dict.clear();
        nextCode = eoiCode + 1;
      } else {
        if (nextCode >= (1 << codeSize)) codeSize++;
        dict.set(key, nextCode++);
      }
      prev = k;
    }
    emit(prev);
    emit(eoiCode);
    if (nbits > 0) out.push(acc & 255);
    return out;
  }

  function push16(bytes, v) {
    bytes.push(v & 255, (v >> 8) & 255);
  }

  function pushStr(bytes, s) {
    for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  }

  function pushBlocks(bytes, data) {
    for (var i = 0; i < data.length; i += 255) {
      var n = Math.min(255, data.length - i);
      bytes.push(n);
      for (var j = 0; j < n; j++) bytes.push(data[i + j]);
    }
    bytes.push(0);
  }

  /**
   * Encode frames into GIF bytes.
   * frames: [{ text, cols, rows, colors?: Int16Array|null, delay: ms }]
   * options: { scale, bg, fg, loop } — loop 0 = forever.
   */
  function encode(frames, options) {
    var o = options || {};
    var scale = Math.max(1, Math.round(o.scale || 1));
    var bg = hexToRGB(o.bg || '#000000');
    var fg = hexToRGB(o.fg || '#c0c0c0');
    var loop = o.loop === undefined ? 0 : o.loop;
    var cols = frames[0].cols, rows = frames[0].rows;
    var W = cols * CELL_W * scale;
    var H = rows * CELL_H * scale;

    // Palette: index 0 = bg, 1 = fg, then any colors used by color mode.
    // Coarsen the color space until everything fits in a 256-entry table.
    var keySet = new Set();
    frames.forEach(function (f) {
      if (!f.colors) return;
      for (var i = 0; i < f.colors.length; i++) if (f.colors[i] >= 0) keySet.add(f.colors[i]);
    });
    var shift = 0;
    while (shift < 3) {
      var reduced = new Set();
      keySet.forEach(function (k) { reduced.add(reduceKey(k, shift)); });
      if (reduced.size <= 254) break;
      shift++;
    }
    var palette = [bg, fg];
    var keyIndex = new Map();
    keySet.forEach(function (k) {
      var rk = reduceKey(k, shift);
      if (!keyIndex.has(rk)) {
        keyIndex.set(rk, palette.length);
        palette.push(reducedToRGB(rk, shift));
      }
    });
    var colorIndex = keySet.size
      ? function (key) { return keyIndex.get(reduceKey(key, shift)); }
      : null;

    var gctBits = 1;
    while ((1 << gctBits) < palette.length) gctBits++;
    var minCodeSize = Math.max(2, gctBits);

    var bytes = [];
    pushStr(bytes, 'GIF89a');
    push16(bytes, W);
    push16(bytes, H);
    bytes.push(0xF0 | (gctBits - 1), 0, 0); // GCT present, color res 7; bg 0; aspect 0
    for (var p = 0; p < (1 << gctBits); p++) {
      var c = palette[p] || [0, 0, 0];
      bytes.push(c[0], c[1], c[2]);
    }

    if (frames.length > 1) { // NETSCAPE looping extension
      bytes.push(0x21, 0xFF, 0x0B);
      pushStr(bytes, 'NETSCAPE2.0');
      bytes.push(3, 1, loop & 255, (loop >> 8) & 255, 0);
    }

    var carry = 0; // diffuse ms→centisecond rounding error across frames
    for (var i = 0; i < frames.length; i++) {
      var ms = (frames[i].delay || 100) + carry;
      var cs = Math.max(2, Math.round(ms / 10));
      carry = ms - cs * 10;

      bytes.push(0x21, 0xF9, 4, 0x04); // GCE: disposal=1 (keep), no transparency
      push16(bytes, cs);
      bytes.push(0, 0);
      bytes.push(0x2C); // image descriptor: full frame
      push16(bytes, 0);
      push16(bytes, 0);
      push16(bytes, W);
      push16(bytes, H);
      bytes.push(0);
      bytes.push(minCodeSize);
      pushBlocks(bytes, lzw(minCodeSize, rasterize(frames[i], scale, W, H, colorIndex)));
    }
    bytes.push(0x3B);
    return Uint8Array.from(bytes);
  }

  // --- capture ------------------------------------------------------------------

  function sameFrame(text, colors, lastText, lastColors) {
    if (text !== lastText) return false;
    if (!colors && !lastColors) return true;
    if (!colors || !lastColors || colors.length !== lastColors.length) return false;
    for (var i = 0; i < colors.length; i++) if (colors[i] !== lastColors[i]) return false;
    return true;
  }

  function captureFrames(df, o) {
    return new Promise(function (resolve, reject) {
      var fd = df.frameData();
      if (!fd.text) {
        reject(new Error('DotFrameExport: nothing rendered yet — call start() first'));
        return;
      }
      // Still image or paused: a single-frame GIF.
      if (df._static || !df._running) {
        resolve([{ text: fd.text, colors: fd.colors ? fd.colors.slice(0) : null, cols: fd.cols, rows: fd.rows, delay: 1000 }]);
        return;
      }

      // Animated GIF/APNG/WebP source: default to exactly one loop.
      var duration = o.duration ||
        (df._frames && df._totalDuration ? Math.max(200, df._totalDuration) : 4000);
      var frames = [];
      var prev = df.options.onFrame;
      var start = 0, done = false, timer = 0;

      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        df.options.onFrame = prev;
        if (!frames.length) {
          reject(new Error('DotFrameExport: no frames captured'));
          return;
        }
        for (var i = 0; i < frames.length - 1; i++) frames[i].delay = frames[i + 1].t - frames[i].t;
        frames[frames.length - 1].delay =
          Math.max(1000 / (df.options.fps || 30), duration - frames[frames.length - 1].t);
        resolve(frames);
      }

      df.options.onFrame = function (str) {
        if (prev) prev(str);
        if (done) return;
        var now = performance.now();
        if (!start) start = now;
        var t = now - start;
        var d = df.frameData();
        var last = frames[frames.length - 1];
        // Skip duplicate frames; their time flows into the previous delay.
        if (!last || !sameFrame(str, d.colors, last.text, last.colors)) {
          frames.push({ text: str, colors: d.colors ? d.colors.slice(0) : null, cols: d.cols, rows: d.rows, t: t });
        }
        if (t >= duration) finish();
      };
      // Safety net in case the source stops producing frames mid-recording.
      timer = setTimeout(finish, duration + 3000);
    });
  }

  /**
   * Record a running DotFrame and return a looping GIF Blob.
   * options: {
   *   duration — ms to record (default: one full loop for animated image
   *              sources, otherwise 4000),
   *   scale    — pixels per dot unit (default 1; frame is cols*5 x rows*10 units),
   *   bg, fg   — hex colors for background and (mono) dots,
   *   loop     — repeat count, 0 = forever (default 0)
   * }
   */
  function gif(df, options) {
    var o = options || {};
    return captureFrames(df, o).then(function (frames) {
      return new Blob([encode(frames, o)], { type: 'image/gif' });
    });
  }

  return {
    gif: gif,
    encode: encode,
    version: '0.1.0',
    _internal: { rasterize: rasterize, lzw: lzw, CELL_W: CELL_W, CELL_H: CELL_H }
  };
});
