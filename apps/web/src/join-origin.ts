export function needsLanAddress(origin: string): boolean {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.replace(/\.$/, '');
    return !['http:', 'https:'].includes(url.protocol)
      || hostname === 'localhost' || hostname.endsWith('.localhost')
      || /^(127(?:\.\d+){3}|0\.0\.0\.0|\[::(?:1)?\]|\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\])$/.test(hostname);
  } catch {
    return true;
  }
}
