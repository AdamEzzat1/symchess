import { useEffect, useRef, useState } from 'react';
import { SAMPLE_PGN } from '../samples';

interface Props {
  onLoad: (pgn: string) => void;
  onClose: () => void;
}

/** Paste a game. The text goes to the engine as it is; the engine reads and checks it. */
export function PgnImport({ onLoad, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog ref={ref} className="sheet sheet-narrow" aria-labelledby="pgn-title" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <form
        className="sheet-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          onLoad(text);
          onClose();
        }}
      >
        <header className="sheet-head">
          <h2 id="pgn-title">Analyse a game</h2>
          <button type="button" className="btn btn-small" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="quiet">
          Paste a game in PGN. The engine checks every move, then goes through the game position by position with a
          short search and Prolog’s facts for each. It replaces the game on the board.
        </p>
        <label className="field">
          <span>PGN</span>
          <textarea
            className="pgn-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder="1. e4 e5 2. Nf3 Nc6 …"
          />
        </label>
        <div className="tour-actions">
          <button type="button" className="btn btn-small" onClick={() => setText(SAMPLE_PGN)}>
            Use a sample game
          </button>
          <span className="tour-spacer" />
          <button type="submit" className="btn btn-primary" disabled={!text.trim()}>
            Analyse
          </button>
        </div>
      </form>
    </dialog>
  );
}
