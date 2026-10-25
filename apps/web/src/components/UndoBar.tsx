/**
 * Undo after a drag-move or resize on the time grid (DECISIONS T-090, "Derived technical choices"):
 * no confirmation dialog; the action stays for 5 seconds, and for as long as it has keyboard
 * focus. It disappears as soon as the block no longer has the times the drag wrote; the command
 * itself also refuses when the block's version changed (version guard).
 */
import { useEffect, useRef, useState } from "react";
import { useServices, useT } from "../app-context.tsx";
import type { VersionVector } from "../backup/versions.ts";
import { type BlockTimes, undoBlockTimes } from "../local/planning.ts";
import type { BlockItem } from "../planning/planning.ts";
import { planningError } from "./planning-ui.tsx";

export const UNDO_MS = 5_000;

export interface UndoOffer {
  blockId: string;
  title: string;
  previous: BlockTimes;
  after: BlockTimes;
  version: VersionVector;
}

export function UndoBar({ offer, blocks, onClose, onError }: { offer: UndoOffer; blocks: readonly BlockItem[]; onClose: () => void; onError: (message: string) => void }) {
  const t = useT();
  const { db } = useServices();
  const [focused, setFocused] = useState(false);
  const timer = useRef<number | null>(null);

  // 5 seconds, paused while focused; a new offer restarts it.
  useEffect(() => {
    if (focused) return;
    timer.current = window.setTimeout(onClose, UNDO_MS);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [offer, focused, onClose]);

  // The block changed again (another edit, a cancel, an import): Undo no longer applies. Right
  // after the drag the live data may still show the times from before it, which is not a change.
  const current = blocks.find((b) => b.id === offer.blockId)?.data;
  const has = (times: BlockTimes) => current?.startsAt === times.startsAt && current.endsAt === times.endsAt;
  const unchanged = !!current && current.status === "planned" && (has(offer.after) || has(offer.previous));
  useEffect(() => {
    if (!unchanged) onClose();
  }, [unchanged, onClose]);
  if (!unchanged) return null;

  return (
    <div
      className="notice notice-info undo-bar"
      role="status"
      data-testid="undo-bar"
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <span>{t("grid.moved", { title: offer.title })}</span>
      <button
        type="button"
        className="secondary"
        onClick={async () => {
          try {
            await undoBlockTimes(db, offer.blockId, offer.previous, offer.version);
          } catch (e) {
            onError(planningError(t, e));
          }
          onClose();
        }}
      >
        {t("grid.undo")}
      </button>
    </div>
  );
}
