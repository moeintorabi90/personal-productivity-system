import { useT } from "../app-context.tsx";
import { formatLocalDate } from "../i18n/index.ts";
import { NO_FILTER } from "../planning/planning.ts";
import { DayPanel, dayPlan, TimeZonePrompt, usePlanning, useToday } from "./planning-ui.tsx";
import { CurrentSessions, useWorkCtx } from "./work-ui.tsx";

/**
 * Today: today's date in the display calendar and configured zone, its blocks (start a session
 * from one, complete it), its unscheduled items with "Schedule" and "Complete", what was completed
 * today, its capacity, and the open session (Stage 5). Habits and goal progress arrive with their
 * stages.
 */
export function TodayView({ onOpenSettings, onOpenWork }: { onOpenSettings?: () => void; onOpenWork?: () => void }) {
  const t = useT();
  const { ctx, loading, zone } = usePlanning();
  const work = useWorkCtx();
  const today = useToday(zone);
  return (
    <>
    {work.ctx ? <CurrentSessions ctx={work.ctx} /> : null}
    <section className="card" aria-labelledby="today-title">
      <h1 id="today-title">{t("today.title")}</h1>
      {!zone && !loading ? <TimeZonePrompt onOpenSettings={onOpenSettings} /> : null}
      {ctx && today ? (
        <>
          <p className="today-date" data-testid="today-date">
            {formatLocalDate(today, ctx)}
          </p>
          {ctx.capacity === undefined ? <p className="hint">{t("today.capacityInvite")}</p> : null}
          <DayPanel ctx={ctx} plan={dayPlan(ctx, today, NO_FILTER)} heading={t("today.plan")} />
          {onOpenWork ? (
            <p className="hint">
              <button type="button" className="link-button" onClick={onOpenWork}>
                {t("today.openWork")}
              </button>
            </p>
          ) : null}
        </>
      ) : null}
    </section>
    </>
  );
}
