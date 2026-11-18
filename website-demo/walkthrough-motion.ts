export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export async function until<T>(read: () => T | null | undefined, signal: AbortSignal): Promise<T> {
  const deadline = performance.now() + 10000;
  for (;;) {
    signal.throwIfAborted();
    const value = read();
    if (value) return value;
    if (performance.now() >= deadline) throw Error('The requested MemCode screen did not open.');
    await pause(25, signal);
  }
}

type TextField = HTMLInputElement | HTMLTextAreaElement;

export function writeField(field: TextField, value: string) {
  const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  // Use the browser setter so React sees the same input event as a typed edit.
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

export async function typeInto(field: TextField, text: string, signal: AbortSignal) {
  field.focus({ preventScroll: true });
  if (reducedMotion()) return writeField(field, text);
  for (let length = 2; length < text.length; length += 2) {
    signal.throwIfAborted();
    writeField(field, text.slice(0, length));
    await pause(43, signal);
  }
  writeField(field, text);
}

export async function animateMove(source: DOMRect, destination: HTMLElement, signal: AbortSignal) {
  if (reducedMotion()) return;
  const end = destination.getBoundingClientRect();
  // Lanes scroll and clip their children. A transient copy of the actual card
  // can cross that boundary while the interactive card stays at its destination.
  const moving = destination.cloneNode(true) as HTMLElement;
  moving.inert = true;
  moving.removeAttribute('data-work-item');
  moving.removeAttribute('role');
  moving.setAttribute('aria-hidden', 'true');
  moving.classList.add('tour-moving-card');
  Object.assign(moving.style, {
    top: end.top + 'px', left: end.left + 'px', width: end.width + 'px', height: end.height + 'px',
  });
  document.body.append(moving);
  destination.style.visibility = 'hidden';
  const motion = moving.animate([
    { transform: 'translate(' + (source.left - end.left) + 'px,' + (source.top - end.top) + 'px)' },
    { transform: 'translate(0,0)' },
  ], { duration: 950, easing: 'cubic-bezier(.35,0,.15,1)', fill: 'both' });
  const cancel = () => motion.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await motion.finished;
  } finally {
    signal.removeEventListener('abort', cancel);
    moving.remove();
    destination.style.removeProperty('visibility');
  }
}
