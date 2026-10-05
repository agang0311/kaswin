const I = {
  logo: '', explore: '<path d="M12 3l7 4v10l-7 4-7-4V7z"/><path d="M12 12l7-5M12 12v9M12 12L5 7"/>', create: '<path d="M12 5v14M5 12h14"/>',
  wallet: '<path d="M3 7h15a3 3 0 013 3v7a3 3 0 01-3 3H6a3 3 0 01-3-3z"/><path d="M3 7l12-4v4M16 14h2"/>', ledger: '<path d="M4 5h16M4 10h16M4 15h10M4 20h7"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/>',
  gauge: '<path d="M4 18a8 8 0 1116 0"/><path d="M12 18l4-6"/>', shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>', ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>', star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  moon: '<path d="M20.5 13.4A8.8 8.8 0 0110.6 3.5a8.8 8.8 0 109.9 9.9z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>', search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>', arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 01-8 0zM6 5H4v2a3 3 0 003 3M18 5h2v2a3 3 0 01-3 3M12 13v4M8 20h8"/>', ticket: '<path d="M4 7h16v3a2 2 0 000 4v3H4v-3a2 2 0 000-4z"/><path d="M14 7v10"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>', refund: '<path d="M4 12a8 8 0 1014-5.3M4 4v5h5"/>', clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 00-2-1.2L14.2 3h-4.4l-.4 2.6a7 7 0 00-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 000 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 002 1.2l.4 2.6h4.4l.4-2.6a7 7 0 002-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>',
  check: '<path d="M5 12l5 5 9-10"/>', download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', node: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.3 11l7.4-3.8M8.3 13l7.4 3.8"/>',
};
export const icon = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${I[n] ?? ''}</svg>`;
