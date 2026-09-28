// One tiny inline illustration, styled by the scoped theme. Always decorative.
export function PartyDecoration() {
  return <svg className="party-decoration" viewBox="0 0 240 160" fill="none" aria-hidden="true" focusable="false">
    <circle className="party-halo" cx="120" cy="83" r="61" />
    <g className="party-stars" fill="currentColor">
      <path d="m40 33 3 9 9 3-9 3-3 9-3-9-9-3 9-3Zm160 64 3 9 9 3-9 3-3 9-3-9-9-3 9-3ZM174 15l2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" />
      <circle cx="68" cy="116" r="3" /><circle cx="190" cy="64" r="3" /><circle cx="57" cy="76" r="2" />
    </g>
    <g className="party-trophy" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M94 47h52v28c0 19-12 30-26 30S94 94 94 75V47ZM94 55H80v11c0 15 8 22 19 23m47-34h14v11c0 15-8 22-19 23m-21 16v19m-19 7h38" />
      <path d="m120 59 3 8 9 1-7 6 2 9-7-5-7 5 2-9-7-6 9-1Z" fill="currentColor" stroke="none" />
    </g>
    <g className="party-bats" fill="currentColor">
      <path d="M40 63c5-2 8-6 9-11 3 7 6 9 10 9l4-5 4 5c5 0 8-2 11-9 1 5 4 9 9 11-7 0-10 2-12 6-4-1-8 1-12 5-4-4-8-6-12-5-2-4-5-6-11-6Z" />
      <path d="M169 37c4-2 6-5 7-9 2 5 4 7 7 7l3-4 3 4c4 0 6-2 8-7 1 4 3 7 7 9-5 0-8 1-9 4-3-1-6 1-9 4-3-3-6-5-9-4-1-3-4-4-8-4Z" />
    </g>
  </svg>;
}
