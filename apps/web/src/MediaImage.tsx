import { useState } from 'react';

export function MediaImage({ src, alt, className = 'matching-image' }: { src?: string; alt: string; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string>();
  return !src || failedSrc === src ? <span role="img" aria-label={alt}>Изображение недоступно / Image unavailable</span>
    : <img className={className} src={src} alt={alt} onError={() => setFailedSrc(src)} />;
}
export function MatchingItemContent({ item }: { item?: { kind: 'text'; text?: string; textRu?: string; textEn?: string } | { kind: 'image'; mediaUrl?: string } }) {
  return item?.kind === 'image' ? <MediaImage src={item.mediaUrl} alt="Изображение / Image" />
    : <>{item?.text ?? (item ? `${item.textRu} / ${item.textEn}` : '')}</>;
}
