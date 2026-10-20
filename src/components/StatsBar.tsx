import type { DiskInfo, ScanProgress } from "../lib/api";
import { formatBytes, formatCount, formatDuration } from "../lib/format";

interface Props {
  disk: DiskInfo | null;
  progress: ScanProgress | null;
  scanning: boolean;
}

export function StatsBar({ disk, progress, scanning }: Props) {
  const usedShare = disk ? disk.used / disk.total : 0;
  const homeShare = disk && progress ? progress.bytes / disk.used : 0;

  return (
    <section className="stats">
      <Stat label={disk ? disk.name : "Disk"} value={disk ? formatBytes(disk.used) : "—"} unit={disk ? `of ${formatBytes(disk.total)}` : undefined}>
        <div className="meter" title={`${Math.round(usedShare * 100)}% used`}>
          <span style={{ width: `${usedShare * 100}%` }} />
        </div>
      </Stat>
      <Stat
        label="Free"
        dot="free"
        value={disk ? formatBytes(disk.available) : "—"}
        unit={disk ? `${Math.round((1 - usedShare) * 100)}%` : undefined}
      />
      <Stat
        label={scanning ? "Home folder · scanning" : "Home folder"}
        dot="home"
        value={progress ? formatBytes(progress.bytes) : "—"}
        unit={progress && disk && !scanning ? `${Math.round(homeShare * 100)}% of used` : undefined}
      />
      <Stat
        label="Files"
        value={progress ? formatCount(progress.files) : "—"}
        unit={progress ? `${formatCount(progress.dirs)} folders` : undefined}
      />
      <Stat
        label="Scan"
        value={progress ? formatDuration(progress.elapsedMs) : "—"}
        unit={progress?.errors ? `${formatCount(progress.errors)} unreadable` : undefined}
      />
    </section>
  );
}

interface StatProps {
  label: string;
  value: string;
  unit?: string;
  dot?: "free" | "home";
  children?: React.ReactNode;
}

function Stat({ label, value, unit, dot, children }: StatProps) {
  return (
    <div className="stat">
      <span className="stat-label">
        {dot && <i className={`dot ${dot}`} />}
        {label}
      </span>
      <span className="stat-value">
        <strong>{value}</strong>
        {unit && <small>{unit}</small>}
      </span>
      {children}
    </div>
  );
}
