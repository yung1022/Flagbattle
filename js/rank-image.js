/**
 * Canvas generator for FLAG BATTLE top-10 ranking cards.
 */

const W = 1080;
const H = 1350;

function ensureFonts() {
  if (document.fonts?.ready) return document.fonts.ready;
  return Promise.resolve();
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * @param {object} opts
 * @param {Array<{rank:number,code:string,name:string,img?:string,points?:number,subtitle?:string}>} opts.entries
 * @param {string} [opts.title]
 * @param {string} [opts.subtitle]
 * @param {string} [opts.footer]
 */
export async function generateTop10Image({
  entries,
  title = "TOP 10",
  subtitle = "FLAG BATTLE",
  footer = "",
} = {}) {
  await ensureFonts();
  const top = (entries || []).slice(0, 10);
  const flags = await Promise.all(
    top.map((e) =>
      loadImage(e.img || `https://flagcdn.com/w160/${e.code}.png`)
    )
  );

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0c1c28");
  bg.addColorStop(0.45, "#071018");
  bg.addColorStop(1, "#050b11");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Atmosphere
  const glow = ctx.createRadialGradient(W * 0.5, 0, 40, W * 0.5, 120, 700);
  glow.addColorStop(0, "rgba(46, 196, 182, 0.22)");
  glow.addColorStop(1, "rgba(46, 196, 182, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const goldGlow = ctx.createRadialGradient(W * 0.8, H * 0.9, 20, W * 0.8, H * 0.9, 420);
  goldGlow.addColorStop(0, "rgba(230, 184, 74, 0.16)");
  goldGlow.addColorStop(1, "rgba(230, 184, 74, 0)");
  ctx.fillStyle = goldGlow;
  ctx.fillRect(0, 0, W, H);

  // Grid hint
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.03)";
  ctx.lineWidth = 1;
  for (let y = 0; y < H; y += 48) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.restore();

  // Brand
  ctx.fillStyle = "#f4f7fa";
  ctx.font = '700 72px "Bebas Neue", "Arial Narrow", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("FLAG BATTLE", W / 2, 88);

  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 96px "Bebas Neue", "Arial Narrow", Impact, sans-serif';
  ctx.fillText(title, W / 2, 178);

  if (subtitle) {
    ctx.fillStyle = "#8fa6b8";
    ctx.font = '700 28px "Manrope", "Segoe UI", sans-serif';
    ctx.fillText(subtitle, W / 2, 220);
  }

  // Divider
  ctx.strokeStyle = "rgba(230, 184, 74, 0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(80, 248);
  ctx.lineTo(W - 80, 248);
  ctx.stroke();

  const startY = 280;
  const rowH = 92;
  const left = 72;
  const right = W - 72;

  top.forEach((entry, i) => {
    const y = startY + i * rowH;
    const isPodium = entry.rank <= 3;

    // Row panel
    ctx.fillStyle = isPodium
      ? "rgba(230, 184, 74, 0.08)"
      : "rgba(18, 36, 51, 0.72)";
    roundRect(ctx, left, y, right - left, rowH - 10, 10);
    ctx.fill();

    ctx.strokeStyle = isPodium
      ? "rgba(230, 184, 74, 0.45)"
      : "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1.5;
    roundRect(ctx, left, y, right - left, rowH - 10, 10);
    ctx.stroke();

    // Rank
    ctx.textAlign = "left";
    ctx.fillStyle =
      entry.rank === 1
        ? "#ffd978"
        : entry.rank === 2
          ? "#c5d0da"
          : entry.rank === 3
            ? "#d08b5a"
            : "#2ec4b6";
    ctx.font = '700 54px "Bebas Neue", "Arial Narrow", Impact, sans-serif';
    ctx.fillText(`#${entry.rank}`, left + 22, y + 58);

    // Flag
    const flag = flags[i];
    const fx = left + 130;
    const fy = y + 16;
    const fw = 72;
    const fh = 48;
    if (flag) {
      ctx.save();
      roundRect(ctx, fx, fy, fw, fh, 4);
      ctx.clip();
      ctx.drawImage(flag, fx, fy, fw, fh);
      ctx.restore();
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1;
      roundRect(ctx, fx, fy, fw, fh, 4);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#123247";
      roundRect(ctx, fx, fy, fw, fh, 4);
      ctx.fill();
    }

    // Name
    ctx.fillStyle = "#f4f7fa";
    ctx.font = '800 34px "Manrope", "Segoe UI", sans-serif';
    ctx.textAlign = "left";
    const name = truncate(ctx, entry.name, 420);
    ctx.fillText(name, fx + fw + 24, y + 52);

    // Right metric (points or place label)
    ctx.textAlign = "right";
    if (entry.points != null) {
      ctx.fillStyle = "#e6b84a";
      ctx.font = '700 48px "Bebas Neue", "Arial Narrow", Impact, sans-serif';
      ctx.fillText(String(entry.points), right - 28, y + 50);
      ctx.fillStyle = "#8fa6b8";
      ctx.font = '700 16px "Manrope", "Segoe UI", sans-serif';
      ctx.fillText("PTS", right - 28, y + 70);
    } else if (entry.subtitle) {
      ctx.fillStyle = "#8fa6b8";
      ctx.font = '700 22px "Manrope", "Segoe UI", sans-serif';
      ctx.fillText(entry.subtitle, right - 28, y + 52);
    }
  });

  if (!top.length) {
    ctx.fillStyle = "#8fa6b8";
    ctx.font = '700 32px "Manrope", "Segoe UI", sans-serif';
    ctx.textAlign = "center";
    ctx.fillText("No ranking data yet", W / 2, H / 2);
  }

  ctx.fillStyle = "#6d8496";
  ctx.font = '600 20px "Manrope", "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(
    footer || "yung1022.github.io/Flagbattle",
    W / 2,
    H - 36
  );

  return canvas;
}

export function canvasToBlob(canvas, type = "image/png", quality = 0.95) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      type,
      quality
    );
  });
}

export async function downloadCanvas(canvas, filename = "flag-battle-top10.png") {
  const blob = await canvasToBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function truncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) {
    s = s.slice(0, -1);
  }
  return `${s}…`;
}
