/**
 * pdfRuns.js
 * Reads every text run of a pdf.js page together with its exact position and fill colour,
 * by walking the page's operator list with a tiny graphics/text-state interpreter.
 *
 * Why not page.getTextContent()? It merges runs and throws the colour away. We need the colour for
 *   1. green/red option text (= correct / wrong answer), and
 *   2. dropping invisible white "tracking" text that is glued onto question text.
 *
 * Coordinates returned are in PDF points with the origin at the TOP-LEFT of the page.
 */

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const IDENT = [1, 0, 0, 1, 0, 0];
// pdf.js wraps some matrices one level deeper depending on the version/op, so accept both shapes.
const mat = (a) => Array.from(Array.isArray(a[0]) || ArrayBuffer.isView(a[0]) ? a[0] : a);

function parseColor(args) {
  if (typeof args[0] === 'string') {
    const h = args[0].replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  if (args.length === 1) return [args[0], args[0], args[0]]; // gray
  return [args[0], args[1], args[2]];
}

/**
 * @returns {Promise<Array<{text:string,x:number,y:number,x2:number,fs:number,color:number[],
 *           chars:string[],adv:number[]}>>}
 */
export async function readTextRuns(page, lib) {
  const { OPS } = lib;
  const vp = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList();
  const { fnArray, argsArray } = ol;

  let ctm = IDENT.slice();
  let fill = [0, 0, 0];
  const stack = [];
  let tm = IDENT, tlm = IDENT;
  let fontSize = 1, leading = 0, charSp = 0, wordSp = 0, hScale = 1;
  const runs = [];

  const moveText = (tx, ty) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };

  const showText = (items) => {
    const start = mul(mul(tm, ctm), vp.transform);
    const chars = [], adv = [];
    let dx = 0; // advance in text space (pre-Tm), already scaled by font size
    const unit = Math.hypot(start[2], start[3]); // pt per text-space unit (vertical axis)
    const push = (ch, w) => { chars.push(ch); adv.push(w * Math.abs(unit)); };
    for (const g of items) {
      if (typeof g === 'number') {                       // TJ kerning adjustment
        const move = (-g / 1000) * fontSize * hScale;
        if (move > fontSize * 0.15) push(' ', move);       // wide gap == implicit space
        else if (adv.length) adv[adv.length - 1] += move * Math.abs(unit);
        dx += move;
        continue;
      }
      if (!g || g.width === undefined) continue;
      let w = (g.width / 1000) * fontSize + charSp + (g.unicode === ' ' ? wordSp : 0);
      w *= hScale;
      push(g.unicode ?? '', w);
      dx += w;
    }
    const end = mul(mul(mul([1, 0, 0, 1, dx, 0], tm), ctm), vp.transform);
    runs.push({
      text: chars.join(''),
      x: start[4], y: start[5], x2: end[4],
      fs: Math.abs(fontSize) * unit,
      color: fill.slice(),
      chars, adv,
    });
    tm = mul([1, 0, 0, 1, dx, 0], tm);
  };

  for (let i = 0; i < fnArray.length; i++) {
    const a = argsArray[i];
    switch (fnArray[i]) {
      case OPS.save: stack.push({ ctm, fill }); break;
      case OPS.restore: if (stack.length) ({ ctm, fill } = stack.pop()); break;
      case OPS.transform: ctm = mul(mat(a), ctm); break;
      case OPS.setFillRGBColor:
      case OPS.setFillGray: fill = parseColor(a); break;
      case OPS.beginText: tm = IDENT; tlm = IDENT; break;
      case OPS.setFont: fontSize = a[1]; break;
      case OPS.setCharSpacing: charSp = a[0]; break;
      case OPS.setWordSpacing: wordSp = a[0]; break;
      case OPS.setHScale: hScale = a[0] / 100; break;
      case OPS.setLeading: leading = a[0]; break;
      case OPS.setTextMatrix: tm = mat(a); tlm = tm; break;
      case OPS.moveText: moveText(a[0], a[1]); break;
      case OPS.setLeadingMoveText: leading = -a[1]; moveText(a[0], a[1]); break;
      case OPS.nextLine: moveText(0, -leading); break;
      case OPS.showText:
      case OPS.showSpacedText: showText(a[0]); break;
      case OPS.nextLineShowText: moveText(0, -leading); showText(a[0]); break;
      case OPS.nextLineSetSpacingShowText:
        wordSp = a[0]; charSp = a[1]; moveText(0, -leading); showText(a[2]); break;
      default: break;
    }
  }
  return runs.filter((r) => r.text.length);
}
