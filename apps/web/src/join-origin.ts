export function needsLanAddress(origin: string): boolean {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.replace(/\.$/, '');
    const ipv4 = /^\d+(?:\.\d+){3}$/.test(hostname) ? hostname.split('.').map(Number) : null;
    const unusableIpv4 = ipv4 && (ipv4[0] === 0 || ipv4[0] === 127 || ipv4[0] >= 224 || (ipv4[0] === 169 && ipv4[1] === 254));
    return Boolean(unusableIpv4) || !['http:', 'https:'].includes(url.protocol)
      || hostname === 'localhost' || hostname.endsWith('.localhost')
      || /^(127(?:\.\d+){3}|0\.0\.0\.0|\[::(?:1)?\]|\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\])$/.test(hostname);
  } catch {
    return true;
  }
}

export function isPrivateIpv4(address: string): boolean {
  if (!/^\d+(?:\.\d+){3}$/.test(address)) return false;
  const parts = address.split('.').map(Number);
  if (parts.some(part => part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}
