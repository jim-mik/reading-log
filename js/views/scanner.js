// Live barcode scanner: camera preview that closes itself when it sees an ISBN.
// Resolves with the ISBN, 'photo' (user chose to take a photo instead) or null.

import { h } from '../util.js';
import { findIsbn } from '../media.js';
import { openOverlay, closeOverlay, icon } from '../ui.js';

export function openScanner() {
  return new Promise((resolve) => {
    let done = false;
    let stream;
    let timer;
    const video = h('video', { playsinline: true, autoplay: true, muted: true });
    const msg = h('p', { class: 'scan-msg' }, '책 뒷면의 바코드(ISBN)를 네모 안에 맞춰 주세요');

    const stop = () => {
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    const finish = async (value) => {
      if (done) return;
      done = true;
      stop();
      await closeOverlay();
      resolve(value);
    };

    const el = h('div', { class: 'page scanner' },
      video,
      h('div', { class: 'scan-frame' }),
      h('button', { class: 'icon-btn scan-close', 'aria-label': '닫기', onClick: () => finish(null) }, icon('close')),
      h('div', { class: 'scan-ui' },
        msg,
        h('button', { class: 'btn ghost light', onClick: () => finish('photo') }, icon('camera'), '사진으로 찍기')));

    openOverlay(el, {
      onClose: () => {
        // Back button pressed.
        if (!done) {
          done = true;
          stop();
          resolve(null);
        }
      },
    });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      } catch {
        msg.textContent = '카메라를 열 수 없어요. 카메라 권한을 허용하거나 "사진으로 찍기"를 눌러 주세요.';
        return;
      }
      if (done) return stop();
      video.srcObject = stream;
      await video.play().catch(() => {});
      const tick = async () => {
        if (done) return;
        if (video.readyState >= 2) {
          const isbn = await findIsbn(video);
          if (isbn) {
            navigator.vibrate?.(60);
            return finish(isbn);
          }
        }
        timer = setTimeout(tick, 150);
      };
      tick();
    })();
  });
}
