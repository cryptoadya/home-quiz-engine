import { useLayoutEffect, useRef, useState } from 'react';

// Measure the actual presentation area, including editor previews. Viewport-only
// breakpoints cannot account for question text, timer, or a short laptop window.
export function usePresentationLayout(contentKey: string, mediaCount: number, host: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || host || typeof ResizeObserver === 'undefined') return;
    const copy = root.querySelector<HTMLElement>('.question-copy');
    const media = root.querySelector<HTMLElement>('.question-media');
    function layout() {
      if (!root!.clientHeight || !copy || !media) return;
      copy.style.setProperty('--copy-scale', '1');
      // Keep a readable lower bound; excessive authored text remains scrollable.
      let scale = 1;
      while (copy.scrollHeight > copy.clientHeight + 1 && scale > .6) {
        scale = Math.max(.6, scale - .05);
        copy.style.setProperty('--copy-scale', String(scale));
      }
      if (mediaCount && media.clientWidth && media.clientHeight) {
        let columns = 1, best = 0;
        for (let n = 1; n <= mediaCount; n++) {
          const size = Math.min(media.clientWidth / n / (4 / 3), media.clientHeight / Math.ceil(mediaCount / n));
          if (size > best) { best = size; columns = n; }
        }
        media.style.setProperty('--media-columns', String(columns));
        media.style.setProperty('--media-rows', String(Math.ceil(mediaCount / columns)));
      }
      setOverflow(copy.scrollHeight > copy.clientHeight + 1 || root!.scrollHeight > root!.clientHeight + 1);
    }
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(root);
    if (media) observer.observe(media);
    return () => observer.disconnect();
  }, [contentKey, mediaCount, host]);
  return { ref, overflow };
}
