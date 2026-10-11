import { useState } from 'react';
import { copyText } from '../clipboard';

interface Props {
  text: string;
  /** Defaults to the corner overlay used inside code blocks. */
  className?: string;
}

/** Copies `text` to the clipboard, then says whether it worked. */
export default function CopyButton({ text, className = 'code-copy' }: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    setState((await copyText(text)) ? 'copied' : 'failed');
    setTimeout(() => setState('idle'), 1600);
  }

  return (
    <button type="button" className={className} onClick={(e) => void copy(e)}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}
