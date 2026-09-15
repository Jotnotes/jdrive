// Which edition this interface was built with. See docs/EDITIONS.md.
//
// JDrive Community has no web/src/hoster/, so the pattern below matches nothing, the
// bundle carries none of the Hosting edition's screens, and `hosting` is null. The
// build decides it, from what is on disk; nothing at runtime can switch it on.
const found = import.meta.glob('./hoster/index.jsx', { eager: true });

export const hosting = (found['./hoster/index.jsx'] || {}).hosting || null;
