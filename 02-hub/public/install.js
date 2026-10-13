(() => {
let installPrompt;
const standalone = matchMedia('(display-mode: standalone)');
const installButtons = document.querySelectorAll('[data-install]');
function updateInstall() {
  installButtons.forEach((button) => {
    button.hidden = standalone.matches;
  });
}
updateInstall();
standalone.addEventListener('change', updateInstall);
addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  updateInstall();
});
addEventListener('appinstalled', () => {
  installPrompt = undefined;
  installButtons.forEach((button) => {
    button.hidden = true;
  });
});
async function showInstall() {
  if (parent !== window && parent.NexusInstall) return parent.NexusInstall.show();
  if (!installPrompt) { document.getElementById('installHelp')?.showModal(); return; }
  const prompt=installPrompt;installPrompt=undefined;await prompt.prompt();await prompt.userChoice;
}
window.NexusInstall={show:showInstall};
installButtons.forEach(button=>button.addEventListener('click',showInstall));
})();
