/**
 * Copy `text`, reporting whether it worked.
 *
 * `navigator.clipboard` only exists in a secure context. Served over plain
 * http — an OpenShift route without TLS, or any host that is not localhost —
 * it is undefined and writeText() would throw, so the copy buttons appear to
 * do nothing. The old selection-based trick still works there.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // denied or unavailable — try the fallback below
    }
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    // off-screen rather than hidden: it has to be selectable to be copied
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
