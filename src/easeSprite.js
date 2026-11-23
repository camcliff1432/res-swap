// One thing's picture easing between its 8-bit look and its low-res look (the same steps as a swap's picture, render.js renderSwap):
// the 8-bit figure in blocks of 2 x 2 pixels, then 4 x 4, then 8 x 8 (each block the average of its pixels), each fading into the
// next, and the last into the low-res figure. The blocks hang from the thing's own corner.
//
//   easeSprite(ctx, p, x, y, size, drawFine, drawLow)
//     p         0 = the 8-bit look ... 1 = the low-res look
//     x, y      where the top-left of a scratch square of `size` pixels (a multiple of 8) falls on ctx
//     drawFine  (sctx) draws the 8-bit figure into that square
//     drawLow   () draws the low-res figure on ctx, where it belongs (ctx.globalAlpha is set for it)
const sets = new Map();
function setOf(size) {
  let s = sets.get(size);
  if (!s) {
    s = [size, size / 2, size / 4, size / 8].map((n) => { const c = document.createElement('canvas'); c.width = c.height = n; return { canvas: c, ctx: c.getContext('2d') }; });
    sets.set(size, s);
  }
  return s;
}

export function easeSprite(ctx, p, x, y, size, drawFine, drawLow) {
  const pics = setOf(size);
  const s = Math.min(3.999, Math.max(0, p * 4)), i = Math.floor(s), f = s - i;
  for (const pic of pics) pic.ctx.clearRect(0, 0, pic.canvas.width, pic.canvas.height);
  drawFine(pics[0].ctx);
  for (let k = 1; k <= Math.min(3, i + 1); k++) {
    pics[k].ctx.imageSmoothingEnabled = true;
    pics[k].ctx.imageSmoothingQuality = 'low';
    pics[k].ctx.drawImage(pics[k - 1].canvas, 0, 0, pics[k - 1].canvas.width, pics[k - 1].canvas.height, 0, 0, pics[k].canvas.width, pics[k].canvas.height);
  }
  const keep = ctx.imageSmoothingEnabled, alpha = ctx.globalAlpha;
  ctx.imageSmoothingEnabled = false;
  const put = (k, a) => {
    if (a <= 0) return;
    ctx.globalAlpha = a;
    if (k === 4) drawLow();
    else ctx.drawImage(pics[k].canvas, 0, 0, pics[k].canvas.width, pics[k].canvas.height, x, y, size, size);
  };
  put(i, i === 3 ? 1 - f : 1);                    // (the last blocks fade out as the low-res figure fades in)
  put(i + 1, f);
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = keep;
}
