// Says that its module was imported at all, which a portal whose interface API is older than it needs must not do:
// the check comes before the import, not only before the call.
window.contractNewLoaded = true;

export default function () {
  window.contractNewCalled = true;
}
