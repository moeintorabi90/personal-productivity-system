/**
 * Undo after a drag-move or resize on the time grid (DECISIONS T-090, "Derived technical choices"):
 * no confirmation dialog; the action stays for 5 seconds, and for as long as it has keyboard
 * focus. It is offered only while the block is unchanged since the drag, judged by its stored
 * VERSION (not only its times): any other edit closes it. The command keeps its own version guard
 * as the final check.
 */
import { useEffect, useRef, useState } from "react";
import { useServices, useT } from "../app-context.tsx";
import { canonicalize } from "../backup/jcs.ts";
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
  /** The block's version before the drag (the live view may still show it right after the drag). */
  previousVersion: VersionVector;
  /** The version the drag wrote: Undo applies only to this one. */
  version: VersionVector;
}

/**
 * Whether Undo still applies to the block as currently shown: it must be planned and show either
 * the version the drag wrote, or — while the live view has not caught up yet — the version from
 * before the drag. Any other version means another edit happened (even one that kept the times).
 */
export function undoApplies(offer: UndoOffer, block: Pick<BlockItem, "data" | "version"> | undefined): boolean {
  if (!block?.version || block.data.status !== "planned") return false;
  const shown = canonicalize(block.version);
  return shown === canonicalize(offer.version) || shown === canonicalize(offer.previousVersion);
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

  // The block changed again (another edit, a cancel, an import): Undo no longer applies.
  const unchanged = undoApplies(offer, blocks.find((b) => b.id === offer.blockId));
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
