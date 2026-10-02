import { useEffect, useRef, useState, type Ref } from 'react';
import type { QuestionMedia } from './lobby';

type PlaybackError = 'blocked' | 'unsupported' | 'failed' | 'replay';
const messages: Record<PlaybackError, string> = {
  blocked: 'Воспроизведение заблокировано. Нажмите Play на этом Screen. / Playback was blocked. Tap Play on this Screen.',
  unsupported: 'Этот формат медиа не воспроизводится на этом устройстве. / This media format cannot be played on this device.',
  failed: 'Не удалось воспроизвести медиа. Повторите на этом Screen или Restart на Host. / Playback failed. Retry on this Screen or Restart on Host.',
  replay: 'Медиа ещё не воспроизводилось на этом Screen. Нажмите Replay. / Media has not played on this Screen yet. Tap Replay.',
};
function playbackError(element: HTMLMediaElement, cause?: unknown): PlaybackError {
  const name = cause && typeof cause === 'object' && 'name' in cause ? cause.name : undefined;
  if (name === 'NotAllowedError') return 'blocked';
  if (name === 'NotSupportedError' || element.error?.code === 3 || element.error?.code === 4) return 'unsupported';
  return 'failed';
}

export function PlayableMedia({ media, onEnded, localControls = false }: { localControls?: boolean; media: QuestionMedia; onEnded?: (mediaId: string, revision: number, duration: number) => void }) {
  const ref = useRef<HTMLMediaElement>(null);
  const completion = useRef({ revision: media.playback?.revision, started: false, reported: false, replaying: false });
  if (completion.current.revision !== media.playback?.revision) completion.current = { revision: media.playback?.revision, started: false, reported: false, replaying: false };
  const endedCallback = useRef(onEnded);
  endedCallback.current = onEnded;
  const retry = useRef<() => void>(() => {});
  const [error, setError] = useState<PlaybackError | null>(null);
  useEffect(() => {
    const element = ref.current!;
    const playback = media.playback;
    const receivedAt = performance.now();
    let active = true;
    const current = () => active && completion.current.revision === playback?.revision;
    function completed() {
      if (!current() || !playback?.playing || !completion.current.started || completion.current.reported || !Number.isFinite(element.duration) || element.duration <= 0) return;
      completion.current.reported = true;
      endedCallback.current?.(media.mediaId, playback.revision, element.duration);
    }
    function play() {
      // Pause peers before starting this element, regardless of React effect order.
      element.parentElement?.querySelectorAll<HTMLMediaElement>('audio, video').forEach(peer => { if (peer !== element) peer.pause(); });
      void element.play().then(() => {
        if (current()) { completion.current.started = true; setError(null); }
      }).catch(cause => { if (current()) setError(playbackError(element, cause)); });
    }
    function synchronize() {
      if (!current() || !playback || element.readyState === 0) return;
      // A local EOF recovery must survive same-attempt projections and Pause/Resume.
      let target = completion.current.replaying ? element.currentTime : playback.positionSeconds + (playback.playing ? (performance.now() - receivedAt) / 1000 : 0);
      if (Number.isFinite(element.duration)) target = Math.min(target, element.duration);
      // Finished audio has no frame to restore, and seeking EOF can fail in MP3 demuxers.
      try { if (!completion.current.replaying && (media.kind !== 'audio' || !Number.isFinite(element.duration) || target < element.duration)) element.currentTime = target; } catch { /* Retry once metadata is ready. */ }
      if (playback.playing && (!Number.isFinite(element.duration) || target < element.duration)) play();
      else {
        element.pause();
        if (playback.playing && target >= element.duration) {
          if (completion.current.started) completed();
          else setError('replay');
        }
      }
    }
    retry.current = () => {
      if (!current() || (playback ? !playback.playing : !localControls)) return;
      const target = playback ? playback.positionSeconds + (performance.now() - receivedAt) / 1000 : element.currentTime;
      if (Number.isFinite(element.duration) && target >= element.duration && !completion.current.started) {
        // Never infer mandatory completion from server time. Replay locally to earn it.
        try { element.currentTime = 0; } catch { setError('failed'); return; }
        completion.current.replaying = true;
      }
      play(); // Called directly from this Screen's click to satisfy user activation.
    };
    setError(null);
    synchronize();
    element.addEventListener('loadedmetadata', synchronize);
    element.addEventListener('ended', completed);
    return () => { active = false; element.removeEventListener('ended', completed); element.removeEventListener('loadedmetadata', synchronize); element.pause(); };
  }, [media.mediaUrl, media.playback, media.kind, localControls]);
  const props = { src: media.mediaUrl, preload: 'metadata', 'aria-label': media.name, controls: localControls, onPlay: () => { if (localControls) ref.current?.parentElement?.querySelectorAll<HTMLMediaElement>('audio, video').forEach(peer => { if (peer !== ref.current) peer.pause(); }); }, onError: () => setError(playbackError(ref.current!)) };
  return <>{media.kind === 'video'
    ? <video key={media.playback?.revision} {...props} ref={ref as Ref<HTMLVideoElement>} playsInline className="question-video" />
    : <audio key={media.playback?.revision} {...props} ref={ref as Ref<HTMLAudioElement>} />}{error && <div className="media-recovery"><p role="alert">{messages[error]}</p>{error !== 'unsupported' && <button disabled={media.playback ? !media.playback.playing : !localControls} onClick={() => retry.current()}>{error === 'replay' ? 'Повторить медиа / Replay media' : 'Воспроизвести медиа / Play media'}</button>}</div>}</>;
}
