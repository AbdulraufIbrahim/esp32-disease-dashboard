import { useEffect, useRef, useState } from "react";
import { ref as dbRef, onValue, set } from "firebase/database";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "./firebase";

// ─────────────────────────────────────────────
// How old a "lastSeen" timestamp can be (ms)
// before the device is considered offline.
// The ESP polls every 3 s; 15 s gives 5 missed
// polls before we call it offline.
// ─────────────────────────────────────────────
const ONLINE_THRESHOLD_MS = 15_000;

function isDeviceOnline(deviceStatus) {
  if (!deviceStatus) return false;
  // The ESP now sets online:true only when connected,
  // but we additionally check the lastSeen heartbeat
  // so the badge goes offline if the ESP disappears.
  const lastSeen = deviceStatus.lastSeen;
  if (!lastSeen) return Boolean(deviceStatus.online);
  // lastSeen is an ISO-like string "YYYY-MM-DD HH:MM:SS"
  // stored in UTC (ESP uses UTC via NTP).
  const parsed = Date.parse(lastSeen.replace(" ", "T") + "Z");
  if (isNaN(parsed)) return Boolean(deviceStatus.online);
  return Date.now() - parsed < ONLINE_THRESHOLD_MS;
}

export default function App() {
  // ── Control state ────────────────────────────
  const [intruderArmed, setIntruderArmed] = useState(false);
  const [scheduleActive, setScheduleActive] = useState(false);
  const [intervalSec, setIntervalSec] = useState(60);
  const [durationMin, setDurationMin] = useState(10);

  // ── Data state ───────────────────────────────
  const [diseaseLatest, setDiseaseLatest] = useState(null);
  const [intruderLatest, setIntruderLatest] = useState(null);
  const [intruderImageUrl, setIntruderImageUrl] = useState(null);
  const [deviceStatus, setDeviceStatus] = useState(null);
  const [latestStatus, setLatestStatus] = useState(null);

  // ── Online badge (re-checked every 5 s) ──────
  const [isOnline, setIsOnline] = useState(false);
  const deviceStatusRef = useRef(null);

  // ── Loading flags ─────────────────────────────
  const [loadingDiseaseSnap, setLoadingDiseaseSnap] = useState(false);
  const [loadingIntruderSnap, setLoadingIntruderSnap] = useState(false);
  const [loadingPlantUpload, setLoadingPlantUpload] = useState(false);
  const [plantUploadResult, setPlantUploadResult] = useState(null);

  const plantFileInputRef = useRef(null);

  // ── Firebase listeners ────────────────────────
  useEffect(() => {
    const unsubControl = onValue(dbRef(db, "control"), (snap) => {
      const data = snap.val() || {};
      setIntruderArmed(Boolean(data.intruderArmed));
      setScheduleActive(Boolean(data.diseaseScheduleActive));
    });

    const unsubConfig = onValue(dbRef(db, "config"), (snap) => {
      const data = snap.val() || {};
      setIntervalSec(data.diseaseIntervalSec || 60);
      setDurationMin(data.diseaseDurationMin || 10);
    });

    const unsubDisease = onValue(dbRef(db, "disease/latest"), (snap) => {
      setDiseaseLatest(snap.val());
    });

    // Manual plant-upload result lives under plant/manual/latest
    const unsubPlantManual = onValue(dbRef(db, "plant/manual/latest"), (snap) => {
      setPlantUploadResult(snap.val());
    });

    const unsubIntruder = onValue(dbRef(db, "intruder/latest"), (snap) => {
      setIntruderLatest(snap.val());
    });

    // Intruder image URL stored by the ESP after uploading to Firebase Storage
    const unsubIntruderImage = onValue(dbRef(db, "intruder/latestImageUrl"), (snap) => {
      setIntruderImageUrl(snap.val());
    });

    const unsubDevice = onValue(dbRef(db, "status/device"), (snap) => {
      const val = snap.val();
      deviceStatusRef.current = val;
      setDeviceStatus(val);
      setIsOnline(isDeviceOnline(val));
    });

    const unsubLatestStatus = onValue(dbRef(db, "status/latest"), (snap) => {
      setLatestStatus(snap.val());
    });

    // Re-evaluate online status every 5 s so the badge
    // reacts when the heartbeat stops arriving.
    const ticker = setInterval(() => {
      setIsOnline(isDeviceOnline(deviceStatusRef.current));
    }, 5_000);

    return () => {
      unsubControl();
      unsubConfig();
      unsubDisease();
      unsubPlantManual();
      unsubIntruder();
      unsubIntruderImage();
      unsubDevice();
      unsubLatestStatus();
      clearInterval(ticker);
    };
  }, []);

  // ── Control actions ───────────────────────────
  const updateIntruderArmed = (value) =>
    set(dbRef(db, "control/intruderArmed"), value);

  const updateScheduleActive = (value) =>
    set(dbRef(db, "control/diseaseScheduleActive"), value);

  const saveScheduleSettings = async () => {
    let safeInterval = Math.max(10, Number(intervalSec));
    let safeDuration = Math.max(1, Number(durationMin));
    await set(dbRef(db, "config/diseaseIntervalSec"), safeInterval);
    await set(dbRef(db, "config/diseaseDurationMin"), safeDuration);
    alert("Disease schedule settings saved.");
  };

  const manualDiseaseSnap = async () => {
    setLoadingDiseaseSnap(true);
    await set(dbRef(db, "commands/diseaseSnap"), true);
    setTimeout(() => setLoadingDiseaseSnap(false), 4000);
  };

  const manualIntruderSnap = async () => {
    setLoadingIntruderSnap(true);
    await set(dbRef(db, "commands/intruderSnap"), true);
    setTimeout(() => setLoadingIntruderSnap(false), 4000);
  };

  // ── Manual plant-image upload ─────────────────
  // 1. User picks a file from their device.
  // 2. File is uploaded to Firebase Storage under plant/manual/<timestamp>.jpg
  // 3. Download URL is stored at plant/manual/uploadUrl in the database.
  // 4. The ESP polls /commands/plantManualSnap; when it finds a URL there
  //    it downloads the image, sends it to Hugging Face, then writes the
  //    result to /plant/manual/latest — which the dashboard listens to above.
  //
  // NOTE: If you prefer the ESP to capture the image itself instead of
  //       accepting an uploaded file, use the manualDiseaseSnap button above.
  const handlePlantFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoadingPlantUpload(true);
    try {
      const timestamp = Date.now();
      const path = `plant/manual/${timestamp}.jpg`;
      const sRef = storageRef(storage, path);
      await uploadBytes(sRef, file, { contentType: file.type || "image/jpeg" });
      const downloadUrl = await getDownloadURL(sRef);

      // Tell the ESP the URL of the uploaded image so it can send it to HF.
      await set(dbRef(db, "commands/plantManualUploadUrl"), downloadUrl);
      await set(dbRef(db, "commands/plantManualSnap"), true);

      alert("Plant image uploaded! Waiting for disease analysis from ESP32…");
    } catch (err) {
      console.error("Plant upload failed:", err);
      alert("Upload failed: " + err.message);
    } finally {
      setLoadingPlantUpload(false);
      // Reset file input so the same file can be re-selected if needed.
      if (plantFileInputRef.current) plantFileInputRef.current.value = "";
    }
  };

  const confidencePercent = diseaseLatest?.confidence
    ? (Number(diseaseLatest.confidence) * 100).toFixed(2)
    : "0.00";

  const manualConfidencePercent = plantUploadResult?.confidence
    ? (Number(plantUploadResult.confidence) * 100).toFixed(2)
    : "0.00";

  return (
    <div className="page">
      {/* ── Header ── */}
      <header className="header">
        <div>
          <h1>ESP32-CAM Disease + Intruder Dashboard</h1>
          <p>
            Control disease detection schedule, manual snaps, and intruder
            monitoring.
          </p>
        </div>

        <div className={isOnline ? "badge online" : "badge offline"}>
          <span className={isOnline ? "pulse-dot green" : "pulse-dot red"} />
          {isOnline ? "ESP32 Online" : "ESP32 Offline"}
        </div>
      </header>

      <section className="grid">
        {/* ── Device Status ── */}
        <div className="card">
          <h2>Device Status</h2>
          <p className="statusText">
            {latestStatus?.message || "Waiting for ESP32-CAM…"}
          </p>
          <small>{latestStatus?.timestamp || "No timestamp"}</small>

          <div className="miniGrid">
            <div>
              <span>Intruder Mode</span>
              <strong>{intruderArmed ? "🔴 Armed" : "🟢 Disarmed"}</strong>
            </div>
            <div>
              <span>Disease Schedule</span>
              <strong>{scheduleActive ? "▶ Running" : "■ Stopped"}</strong>
            </div>
            <div>
              <span>Last Seen</span>
              <strong>{deviceStatus?.lastSeen || "—"}</strong>
            </div>
            <div>
              <span>Interval / Duration</span>
              <strong>
                {deviceStatus?.diseaseIntervalSec ?? intervalSec}s /{" "}
                {deviceStatus?.diseaseDurationMin ?? durationMin}min
              </strong>
            </div>
          </div>
        </div>

        {/* ── Intruder Control ── */}
        <div className="card">
          <h2>🔒 Intruder Control</h2>
          <p>
            Arm or disarm PIR intruder detection. On detection the image is
            sent to Telegram <em>and</em> stored on this dashboard.
          </p>

          <button
            className={intruderArmed ? "btn danger" : "btn success"}
            onClick={() => updateIntruderArmed(!intruderArmed)}
          >
            {intruderArmed ? "Disarm Intruder Mode" : "Arm Intruder Mode"}
          </button>

          <button className="btn" onClick={manualIntruderSnap}>
            {loadingIntruderSnap ? "Sending Command…" : "Manual Intruder Snap"}
          </button>
        </div>

        {/* ── Disease Schedule ── */}
        <div className="card">
          <h2>🌿 Disease Detection Schedule</h2>
          <p>
            Set how often the ESP32-CAM should capture plant images and how
            long the schedule should run.
          </p>

          <label>
            Interval between snaps (seconds)
            <input
              type="number"
              min="10"
              value={intervalSec}
              onChange={(e) => setIntervalSec(e.target.value)}
            />
          </label>

          <label>
            Duration (minutes)
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

        {/* ── Manual Disease Snap (ESP captures) ── */}
        <div className="card">
          <h2>📸 Manual Disease Snap</h2>
          <p>
            Tell the ESP32-CAM to capture a plant image now. The image is sent
            directly to Hugging Face — only the result is shown here.
          </p>

          <button className="btn success" onClick={manualDiseaseSnap}>
            {loadingDiseaseSnap
              ? "Sending Command…"
              : "Snap for Disease Detection"}
          </button>
        </div>

        {/* ── Manual Plant-Image Upload ── */}
        <div className="card">
          <h2>📤 Upload Plant Image for Analysis</h2>
          <p>
            Upload a plant photo from your device. It will be sent to Hugging
            Face via the ESP32 and the result will appear below and on
            Telegram.
          </p>

          {/* Hidden file input */}
          <input
            id="plantFileInput"
            ref={plantFileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handlePlantFileChange}
          />

          <button
            className="btn success"
            disabled={loadingPlantUpload}
            onClick={() => plantFileInputRef.current?.click()}
          >
            {loadingPlantUpload ? "Uploading…" : "Choose & Upload Plant Image"}
          </button>

          {plantUploadResult && (
            <div className="resultBox" style={{ marginTop: "14px" }}>
              <div>
                <span>Label</span>
                <strong>{plantUploadResult.label || "—"}</strong>
              </div>
              <div>
                <span>Confidence</span>
                <strong>{manualConfidencePercent}%</strong>
              </div>
              <div>
                <span>Time</span>
                <strong>{plantUploadResult.timestamp || "—"}</strong>
              </div>
              {plantUploadResult.imageUrl && (
                <div className="span-two">
                  <span>Uploaded Image</span>
                  <a
                    href={plantUploadResult.imageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="img-link"
                  >
                    🔗 View Uploaded Plant Image
                  </a>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Latest Disease Result ── */}
        <div className="card wide">
          <h2>🌱 Latest Disease Detection Result</h2>

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

        {/* ── Latest Intruder Event ── */}
        <div className="card wide">
          <h2>🚨 Latest Intruder Event</h2>

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
                <strong>{intruderLatest.telegramSent ? "✅ Yes" : "❌ No"}</strong>
              </div>
              <div>
                <span>Time</span>
                <strong>{intruderLatest.timestamp || "N/A"}</strong>
              </div>

              {/* Intruder image link — opens full image in a new tab */}
              {intruderImageUrl && (
                <div className="span-two">
                  <span>Captured Image</span>
                  <a
                    href={intruderImageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="img-link"
                  >
                    🔗 View Intruder Image
                  </a>
                </div>
              )}
            </div>
          ) : (
            <p>No intruder event yet.</p>
          )}
        </div>
      </section>

      <footer>
        <p>
          Plant images are analysed in the cloud — only the result is stored on
          the dashboard. Intruder images are sent to Telegram and displayed
          here as a secure link.
        </p>
      </footer>
    </div>
  );
}