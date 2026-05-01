import { useEffect, useState } from "react";
import { ref, onValue, set } from "firebase/database";
import { db } from "./firebase";

export default function App() {
  const [intruderArmed, setIntruderArmed] = useState(false);
  const [scheduleActive, setScheduleActive] = useState(false);

  const [intervalSec, setIntervalSec] = useState(60);
  const [durationMin, setDurationMin] = useState(10);

  const [diseaseLatest, setDiseaseLatest] = useState(null);
  const [intruderLatest, setIntruderLatest] = useState(null);
  const [deviceStatus, setDeviceStatus] = useState(null);
  const [latestStatus, setLatestStatus] = useState(null);

  const [loadingDiseaseSnap, setLoadingDiseaseSnap] = useState(false);
  const [loadingIntruderSnap, setLoadingIntruderSnap] = useState(false);

  useEffect(() => {
    const unsubControl = onValue(ref(db, "control"), (snapshot) => {
      const data = snapshot.val() || {};
      setIntruderArmed(Boolean(data.intruderArmed));
      setScheduleActive(Boolean(data.diseaseScheduleActive));
    });

    const unsubConfig = onValue(ref(db, "config"), (snapshot) => {
      const data = snapshot.val() || {};
      setIntervalSec(data.diseaseIntervalSec || 60);
      setDurationMin(data.diseaseDurationMin || 10);
    });

    const unsubDisease = onValue(ref(db, "disease/latest"), (snapshot) => {
      setDiseaseLatest(snapshot.val());
    });

    const unsubIntruder = onValue(ref(db, "intruder/latest"), (snapshot) => {
      setIntruderLatest(snapshot.val());
    });

    const unsubDevice = onValue(ref(db, "status/device"), (snapshot) => {
      setDeviceStatus(snapshot.val());
    });

    const unsubLatestStatus = onValue(ref(db, "status/latest"), (snapshot) => {
      setLatestStatus(snapshot.val());
    });

    return () => {
      unsubControl();
      unsubConfig();
      unsubDisease();
      unsubIntruder();
      unsubDevice();
      unsubLatestStatus();
    };
  }, []);

  const updateIntruderArmed = async (value) => {
    await set(ref(db, "control/intruderArmed"), value);
  };

  const updateScheduleActive = async (value) => {
    await set(ref(db, "control/diseaseScheduleActive"), value);
  };

  const saveScheduleSettings = async () => {
    let safeInterval = Number(intervalSec);
    let safeDuration = Number(durationMin);

    if (safeInterval < 10) safeInterval = 10;
    if (safeDuration < 1) safeDuration = 1;

    await set(ref(db, "config/diseaseIntervalSec"), safeInterval);
    await set(ref(db, "config/diseaseDurationMin"), safeDuration);

    alert("Disease schedule settings saved.");
  };

  const manualDiseaseSnap = async () => {
    setLoadingDiseaseSnap(true);
    await set(ref(db, "commands/diseaseSnap"), true);

    setTimeout(() => {
      setLoadingDiseaseSnap(false);
    }, 3000);
  };

  const manualIntruderSnap = async () => {
    setLoadingIntruderSnap(true);
    await set(ref(db, "commands/intruderSnap"), true);

    setTimeout(() => {
      setLoadingIntruderSnap(false);
    }, 3000);
  };

  const confidencePercent = diseaseLatest?.confidence
    ? (Number(diseaseLatest.confidence) * 100).toFixed(2)
    : "0.00";

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>ESP32-CAM Disease + Intruder Dashboard</h1>
          <p>
            Control disease detection schedule, manual snaps, and intruder
            monitoring.
          </p>
        </div>

        <div className={deviceStatus?.online ? "badge online" : "badge offline"}>
          {deviceStatus?.online ? "ESP32 Online" : "ESP32 Offline / Waiting"}
        </div>
      </header>

      <section className="grid">
        <div className="card">
          <h2>Device Status</h2>
          <p className="statusText">
            {latestStatus?.message || "Waiting for ESP32-CAM..."}
          </p>
          <small>{latestStatus?.timestamp || "No timestamp"}</small>

          <div className="miniGrid">
            <div>
              <span>Intruder Mode</span>
              <strong>{intruderArmed ? "Armed" : "Disarmed"}</strong>
            </div>
            <div>
              <span>Disease Schedule</span>
              <strong>{scheduleActive ? "Running" : "Stopped"}</strong>
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Intruder Control</h2>
          <p>
            Arm or disarm PIR intruder detection. Intruder images go to Telegram
            only.
          </p>

          <button
            className={intruderArmed ? "btn danger" : "btn success"}
            onClick={() => updateIntruderArmed(!intruderArmed)}
          >
            {intruderArmed ? "Disarm Intruder Mode" : "Arm Intruder Mode"}
          </button>

          <button className="btn" onClick={manualIntruderSnap}>
            {loadingIntruderSnap ? "Sending Command..." : "Manual Intruder Snap"}
          </button>
        </div>

        <div className="card">
          <h2>Disease Detection Schedule</h2>
          <p>
            Set how often ESP32-CAM should capture plant images and how long the
            schedule should run.
          </p>

          <label>
            Interval between snaps, seconds
            <input
              type="number"
              min="10"
              value={intervalSec}
              onChange={(e) => setIntervalSec(e.target.value)}
            />
          </label>

          <label>
            Duration, minutes
            <input
              type="number"
              min="1"
              value={durationMin}
              onChange={(e) => setDurationMin(e.target.value)}
            />
          </label>

          <button className="btn" onClick={saveScheduleSettings}>
            Save Schedule Settings
          </button>

          <button
            className={scheduleActive ? "btn danger" : "btn success"}
            onClick={() => updateScheduleActive(!scheduleActive)}
          >
            {scheduleActive ? "Stop Disease Schedule" : "Start Disease Schedule"}
          </button>
        </div>

        <div className="card">
          <h2>Manual Disease Snap</h2>
          <p>
            Capture one plant image now. The plant image goes to Hugging Face
            only. Only the result appears here and on Telegram.
          </p>

          <button className="btn success" onClick={manualDiseaseSnap}>
            {loadingDiseaseSnap ? "Sending Command..." : "Snap for Disease Detection"}
          </button>
        </div>

        <div className="card wide">
          <h2>Latest Disease Result</h2>

          {diseaseLatest ? (
            <div className="resultBox">
              <div>
                <span>Label</span>
                <strong>{diseaseLatest.label || "No label yet"}</strong>
              </div>

              <div>
                <span>Confidence</span>
                <strong>{confidencePercent}%</strong>
              </div>

              <div>
                <span>Source</span>
                <strong>{diseaseLatest.source || "N/A"}</strong>
              </div>

              <div>
                <span>Time</span>
                <strong>{diseaseLatest.timestamp || "N/A"}</strong>
              </div>
            </div>
          ) : (
            <p>No disease result yet.</p>
          )}
        </div>

        <div className="card wide">
          <h2>Latest Intruder Event</h2>

          {intruderLatest ? (
            <div className="resultBox">
              <div>
                <span>Event</span>
                <strong>{intruderLatest.event || "No event yet"}</strong>
              </div>

              <div>
                <span>Source</span>
                <strong>{intruderLatest.source || "N/A"}</strong>
              </div>

              <div>
                <span>Telegram Sent</span>
                <strong>{intruderLatest.telegramSent ? "Yes" : "No"}</strong>
              </div>

              <div>
                <span>Time</span>
                <strong>{intruderLatest.timestamp || "N/A"}</strong>
              </div>
            </div>
          ) : (
            <p>No intruder event yet.</p>
          )}
        </div>
      </section>

      <footer>
        <p>
          Plant images are not stored on the dashboard. Intruder images are not
          sent to the disease detection cloud.
        </p>
      </footer>
    </div>
  );
}