'use strict';

// 从 qrcode-terminal 的 vendor QRCode 类生成 SVG 二维码（网页邀请弹窗用）
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

function qrSvg(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4; // 四周留白（扫码识别需要）
  const size = n + quiet * 2;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`;
  s += `<rect width="100%" height="100%" fill="#ffffff"/>`;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules[r][c]) {
        s += `<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1" fill="#000000"/>`;
      }
    }
  }
  s += '</svg>';
  return s;
}

module.exports = { qrSvg };
