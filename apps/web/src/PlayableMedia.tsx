import { useEffect, useRef, useState, type Ref } from 'react';
import type { QuestionMedia } from './lobby';

export function PlayableMedia({ media, onEnded }: { media: QuestionMedia; onEnded?: (mediaId: string, revision: number, duration: number) => void }) {
  const ref = useRef<HTMLMediaElement>(null);
  const endedCallback = useRef(onEnded);
  endedCallback.current = onEnded;
  const [error, setError] = useState('');
  useEffect(() => {
    const element = ref.current!;
    const playback = media.playback;
    const receivedAt = performance.now();
    let active = true;
    let reported = false;
    function completed() {
      if (!active || reported || !playback?.playing || !Number.isFinite(element.duration) || element.duration <= 0) return;
      reported = true;
      endedCallback.current?.(media.mediaId, playback.revision, element.duration);
    }
    function synchronize() {
      if (!active || !playback || element.readyState === 0) return;
      let target = playback.positionSeconds + (playback.playing ? (performance.now() - receivedAt) / 1000 : 0);
      if (Number.isFinite(element.duration)) target = Math.min(target, element.duration);
      // Finished audio has no frame to restore, and seeking EOF can fail in MP3 demuxers.
      try { if (media.kind !== 'audio' || !Number.isFinite(element.duration) || target < element.duration) element.currentTime = target; } catch { /* Retry once metadata is ready. */ }
      if (playback.playing && (!Number.isFinite(element.duration) || target < element.duration)) {
        // Pause peers before starting this element, regardless of React effect order.
        element.parentElement?.querySelectorAll<HTMLMediaElement>('audio, video').forEach(peer => { if (peer !== element) peer.pause(); });
        void element.play().then(() => { if (active) setError(''); }).catch(() => {
          if (active) setError('Воспроизведение заблокировано браузером / Browser blocked playback. Allow autoplay for this Screen, then retry Play on Host.');
        });
      } else { element.pause(); if (playback.playing && target >= element.duration) completed(); }
    }
    synchronize();
    element.addEventListener('loadedmetadata', synchronize);
    element.addEventListener('ended', completed);
    return () => { active = false; element.removeEventListener('ended', completed); element.removeEventListener('loadedmetadata', synchronize); element.pause(); };
  }, [media.mediaUrl, media.playback]);
  const props = { src: media.mediaUrl, preload: 'metadata', 'aria-label': media.name, onError: () => setError('Медиа недоступно / Media unavailable') };
  return <>{media.kind === 'video'
    ? <video {...props} ref={ref as Ref<HTMLVideoElement>} playsInline className="question-video" />
    : <audio {...props} ref={ref as Ref<HTMLAudioElement>} />}{error && <p role="alert">{error}</p>}</>;
}
