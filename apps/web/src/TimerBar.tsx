import type { TimeEntry } from "@hoosier/shared";
import { useEffect, useState } from "react";
import { stopTimer } from "./api";

function elapsed(startedAt: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Shows the member's running timer on every page, with a stop button. Only one timer can run at a time. */
export function TimerBar({ timer, onStopped }: { timer: TimeEntry; onStopped: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <output className="timer-bar">
      <span>
        Timer running on ticket <strong>#{timer.ticketId}</strong>
      </span>
      <span className="mono">{timer.startedAt ? elapsed(timer.startedAt, now) : ""}</span>
      {error && <span className="error-text">{error}</span>}
      <button
        type="button"
        className="btn"
        onClick={() =>
          stopTimer()
            .then(onStopped)
            .catch((e) => setError(e instanceof Error ? e.message : "Could not stop"))
        }
      >
        Stop
      </button>
    </output>
  );
}
