import { useEffect, useState } from 'react';
import { isPrivateIpv4, needsLanAddress } from './join-origin';

export type NetworkAddress = { name: string; address: string };

export function reachableOrigin(address: string, currentOrigin: string): string | null {
  try {
    const current = new URL(currentOrigin);
    const url = new URL(address.includes('://') ? address.trim() : `${current.protocol}//${address.trim()}`);
    if (needsLanAddress(url.origin) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    if (!url.port) url.port = current.port;
    return url.origin;
  } catch { return null; }
}

export function useShareOrigin(enabled = true) {
  const current = window.location.origin;
  const [origin, setOrigin] = useState<string | null>(() => needsLanAddress(current) ? null : current);
  const [addresses, setAddresses] = useState<NetworkAddress[]>([]);
  useEffect(() => {
    if (!enabled || !needsLanAddress(current)) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch('/api/network', { cache: 'no-store' });
        if (!response.ok) throw new Error('Network addresses unavailable');
        const body = await response.json();
        const candidates: NetworkAddress[] = Array.isArray(body.addresses) ? body.addresses.filter((item: NetworkAddress) =>
          typeof item?.address === 'string' && typeof item.name === 'string' && isPrivateIpv4(item.address) && reachableOrigin(item.address, current)) : [];
        const unique = candidates.filter((item, index) => candidates.findIndex(other => other.address === item.address) === index);
        if (active) {
          setAddresses(unique);
          if (unique.length === 1) setOrigin(reachableOrigin(unique[0].address, current));
        }
      } catch { /* Screen can still be opened manually using the Mac’s LAN address. */ }
    })();
    return () => { active = false; };
  }, [current, enabled]);
  return { origin, setOrigin, addresses };
}
