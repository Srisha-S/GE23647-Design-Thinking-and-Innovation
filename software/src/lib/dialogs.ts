let openingOrder = 0;

/** Track the native top-layer order, including pickers opened inside forms. */
export function openModal(dialog: HTMLDialogElement) {
  dialog.showModal();
  dialog.dataset.modalOrder = String(++openingOrder);
}

export function topmostDialog(): HTMLDialogElement | undefined {
  return Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]'))
    .sort((a, b) => Number(b.dataset.modalOrder || 0) - Number(a.dataset.modalOrder || 0))[0];
}
