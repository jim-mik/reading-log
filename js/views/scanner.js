// Live barcode scanner: camera preview that closes itself when it sees an ISBN.
// Resolves with the ISBN, 'photo' (user chose to take a photo instead) or null.
// Phone cameras blur when held close to a book, so: the main back camera, continuous autofocus,
// 2x zoom by default (the book can stay 20-30 cm away), tap to focus, and a torch. Barcodes are
// looked for inside the on-screen frame at full camera resolution, with the whole picture now and then.

import { h } from '../util.js';
import { findIsbn } from '../media.js';
import { openOverlay, closeOverlay, icon } from '../ui.js';

const ZOOMS = [1, 2, 3];

async function openCamera() {
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  let stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, ...size }, audio: false });
  // Phones with several back cameras may hand out the ultra-wide one, which can't focus up close.
  // Labels are readable once permission is given; on Android "camera2 0" is the main back camera.
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const main = cams.find((d) => /camera2 0\b/.test(d.label) && /back/i.test(d.label));
    if (main && main.deviceId !== stream.getVideoTracks()[0].getSettings().deviceId) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: main.deviceId }, ...size }, audio: false });
    }
  } catch {
    // keep the camera we have
  }
  return stream;
}

export function openScanner() {
  return new Promise((resolve) => {
    let done = false;
    let stream;
    let track;
    let caps = {};
    let timer;
    const video = h('video', { playsinline: true, autoplay: true, muted: true });
    const frame = h('div', { class: 'scan-frame' });
    const msg = h('p', { class: 'scan-msg' }, '책에서 한 뼘쯤 떨어져서 뒷면 바코드(ISBN)를 네모 안에 맞춰 주세요. 흐리면 화면을 눌러 초점을 맞춰요.');
    const tools = h('div', { class: 'scan-tools', hidden: true });

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
    const apply = (c) => track.applyConstraints({ advanced: [c] }).catch(() => {});

    // Tap to focus where the finger is, then back to continuous focus.
    video.addEventListener('click', (e) => {
      if (!track || !caps.focusMode?.includes('single-shot')) return;
      const r = video.getBoundingClientRect();
      apply({ focusMode: 'single-shot', pointsOfInterest: [{ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }] });
      if (caps.focusMode.includes('continuous')) setTimeout(() => !done && apply({ focusMode: 'continuous' }), 2000);
    });

    const el = h('div', { class: 'page scanner' },
      video, frame,
      h('button', { class: 'icon-btn scan-close', 'aria-label': '닫기', onClick: () => finish(null) }, icon('close')),
      h('div', { class: 'scan-ui' },
        tools, msg,
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

    // Zoom and torch buttons, only for what this camera can do.
    async function setUpCamera() {
      track = stream.getVideoTracks()[0];
      caps = track.getCapabilities?.() ?? {};
      if (caps.focusMode?.includes('continuous')) await apply({ focusMode: 'continuous' });
      const zooms = caps.zoom ? ZOOMS.filter((z) => z >= caps.zoom.min && z <= caps.zoom.max) : [];
      if (zooms.length > 1) {
        const buttons = zooms.map((z) => h('button', { type: 'button', class: 'chip', onClick: () => zoom(z) }, `${z}×`));
        const zoom = (z) => {
          apply({ zoom: z });
          buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(zooms[i] === z)));
        };
        tools.append(...buttons);
        zoom(zooms.includes(2) ? 2 : zooms[0]);
      }
      if (caps.torch) {
        let on = false;
        const torch = h('button', {
          type: 'button', class: 'chip', 'aria-pressed': 'false',
          onClick: () => {
            on = !on;
            apply({ torch: on });
            torch.setAttribute('aria-pressed', String(on));
          },
        }, '손전등');
        tools.append(torch);
      }
      tools.hidden = !tools.childElementCount;
    }

    // The frame (plus a margin) in camera pixels; the video fills the screen like CSS object-fit: cover.
    const canvas = document.createElement('canvas');
    function frameCrop() {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const box = video.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      const scale = Math.max(box.width / vw, box.height / vh);
      const ox = box.left + (box.width - vw * scale) / 2;
      const oy = box.top + (box.height - vh * scale) / 2;
      const x = Math.max(0, (f.left - f.width * 0.15 - ox) / scale);
      const y = Math.max(0, (f.top - f.height * 0.5 - oy) / scale);
      const w = Math.min(vw - x, (f.width * 1.3) / scale);
      const hh = Math.min(vh - y, (f.height * 2) / scale);
      if (!(w > 16 && hh > 16)) return video;
      canvas.width = Math.round(w);
      canvas.height = Math.round(hh);
      canvas.getContext('2d').drawImage(video, x, y, w, hh, 0, 0, canvas.width, canvas.height);
      return canvas;
    }

    (async () => {
      try {
        stream = await openCamera();
      } catch {
        msg.textContent = '카메라를 열 수 없어요. 카메라 권한을 허용하거나 "사진으로 찍기"를 눌러 주세요.';
        return;
      }
      if (done) return stop();
      video.srcObject = stream;
      await video.play().catch(() => {});
      await setUpCamera();
      let n = 0;
      const tick = async () => {
        if (done) return;
        if (video.readyState >= 2 && video.videoWidth) {
          const isbn = await findIsbn(++n % 4 === 0 ? video : frameCrop());
          if (isbn) {
            navigator.vibrate?.(60);
            return finish(isbn);
          }
        }
        timer = setTimeout(tick, 120);
      };
      tick();
    })();
  });
}
