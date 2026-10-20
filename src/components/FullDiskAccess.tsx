import { useEffect, useState } from "react";
import { fullDiskAccess, openFullDiskAccessSettings, relaunch } from "../lib/api";
import icon from "../assets/icon.png";

/** How often to check whether access was granted while the steps are on screen. */
const POLL_MS = 2000;

interface Props {
  /** Shown in a modal (from the unreadable-folders banner) rather than as the start screen. */
  modal?: boolean;
  onSkip: () => void;
}

/** Walks through giving Kurz Full Disk Access, so it can read ~/Library. */
export function FullDiskAccess({ modal, onSkip }: Props) {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    const check = () => fullDiskAccess().then(setGranted, () => setGranted(false));
    check();
    const timer = window.setInterval(check, POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const body = (
    <section className={`card fda ${modal ? "in-modal" : ""}`} onClick={(e) => e.stopPropagation()}>
      <img src={icon} alt="" className="fda-icon" />
      <h2>Give Kurz Full Disk Access</h2>
      <p className="sub">
        Most of what Kurz can clean lives in <span className="mono">~/Library</span>: app caches, logs, simulators, Docker, other apps’ data.
        Without full access macOS hides some of it and asks before Kurz may read other apps’ data. Kurz only reads while scanning, and
        nothing leaves your Mac.
      </p>

      <ol className="fda-steps">
        <li>
          <span className="mono">1</span>
          <div>
            <strong>Open System Settings</strong>
            <span className="muted">It opens at Privacy &amp; Security → Full Disk Access.</span>
          </div>
          <button
            onClick={() => {
              setOpened(true);
              openFullDiskAccessSettings().catch(() => {});
            }}
          >
            Open Settings
          </button>
        </li>
        <li>
          <span className="mono">2</span>
          <div>
            <strong>Turn on Kurz</strong>
            <span className="muted">Not in the list? Click +, then choose Kurz in Applications.</span>
          </div>
        </li>
        <li>
          <span className="mono">3</span>
          <div>
            <strong>Reopen Kurz</strong>
            <span className="muted">macOS applies the change after Kurz restarts.</span>
          </div>
          <button className={opened ? "cta" : ""} onClick={() => relaunch().catch(() => {})}>
            Quit &amp; Reopen
          </button>
        </li>
      </ol>

      <div className="fda-foot">
        <span className={`tag ${granted ? "ok" : "warn"}`}>{granted === null ? "Checking…" : granted ? "Full Disk Access is on" : "Not granted yet"}</span>
        <button className="link muted" onClick={onSkip}>
          {granted ? "Continue" : modal ? "Not now" : "Scan without it"}
        </button>
      </div>
    </section>
  );

  return modal ? (
    <div className="overlay center" onClick={onSkip}>
      {body}
    </div>
  ) : (
    <div className="fda-page">{body}</div>
  );
}
