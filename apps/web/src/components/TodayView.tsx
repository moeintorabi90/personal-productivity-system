import { useT } from "../app-context.tsx";
import { formatLocalDate } from "../i18n/index.ts";
import { NO_FILTER } from "../planning/planning.ts";
import { DayPanel, dayPlan, TimeZonePrompt, usePlanning, useToday } from "./planning-ui.tsx";

/**
 * Today (Stage 3 part): today's date in the display calendar and configured zone, its blocks,
 * its unscheduled items with "Schedule", and its capacity. Actual work, habits, and goal progress
 * arrive with their stages.
 */
export function TodayView({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const t = useT();
  const { ctx, loading, zone } = usePlanning();
  const today = useToday(zone);
  return (
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
        </>
      ) : null}
    </section>
  );
}
