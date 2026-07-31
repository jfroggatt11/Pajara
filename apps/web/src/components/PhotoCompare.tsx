import {useEffect, useMemo, useState} from "react";
import {
  groupPhotos,
  photoDateKey,
  photoSeriesKey,
  photoTimestamp,
  photoViewLabel,
} from "../lib/photos";
import {supabase} from "../lib/supabase";
import type {BodyArea} from "../types";

interface PhotoRow {
  id: string;
  body_area_code: string | null;
  view_code: string | null;
  created_at: string;
  artifacts: {
    bucket: string;
    object_path: string;
    captured_at: string | null;
  };
}

interface PhotoLink {
  id: string;
  bodyAreaCode: string | null;
  viewCode: string | null;
  capturedAt: string | null;
  createdAt: string;
  bucket: string;
  objectPath: string;
}

type PhotoMode = "series" | "day";

export function PhotoCompare({
  refreshKey,
  bodyAreas,
  timezone,
}: {
  refreshKey: number;
  bodyAreas: BodyArea[];
  timezone: string;
}) {
  const [photos, setPhotos] = useState<PhotoLink[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<PhotoMode>("series");
  const [selectedSeries, setSelectedSeries] = useState("");
  const [selectedDay, setSelectedDay] = useState("");
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [opacity, setOpacity] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    async function loadAllPhotos() {
      const rows: PhotoRow[] = [];
      const pageSize = 500;
      for (let from = 0; ; from += pageSize) {
        const {data, error: loadError} = await supabase
          .from("record_artifacts")
          .select(
            "id,body_area_code,view_code,created_at,artifacts!inner(bucket,object_path,captured_at)",
          )
          .eq("role", "skin_photo")
          .order("created_at", {ascending: false})
          .order("id", {ascending: false})
          .range(from, from + pageSize - 1);
        if (cancelled) return;
        if (loadError) {
          setError(loadError.message);
          setLoading(false);
          return;
        }
        const page = (data || []) as unknown as PhotoRow[];
        rows.push(...page);
        if (page.length < pageSize) break;
      }
      const loaded = rows.map((row) => ({
        id: row.id,
        bodyAreaCode: row.body_area_code,
        viewCode: row.view_code,
        capturedAt: row.artifacts.captured_at,
        createdAt: row.created_at,
        bucket: row.artifacts.bucket,
        objectPath: row.artifacts.object_path,
      }));
      setPhotos(loaded);
      setSignedUrls({});
      setLoading(false);
    }
    void loadAllPhotos();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const areaLabels = useMemo(
    () => Object.fromEntries(bodyAreas.map((area) => [area.code, area.label])),
    [bodyAreas],
  );
  const seriesGroups = useMemo(
    () => groupPhotos(photos, photoSeriesKey),
    [photos],
  );
  const dayGroups = useMemo(
    () => groupPhotos(photos, (photo) => photoDateKey(photo, timezone)),
    [photos, timezone],
  );
  const seriesKeys = useMemo(
    () => Object.keys(seriesGroups).sort((left, right) => {
      const leftLatest = seriesGroups[left].at(-1);
      const rightLatest = seriesGroups[right].at(-1);
      return (rightLatest ? new Date(photoTimestamp(rightLatest)).getTime() : 0)
        - (leftLatest ? new Date(photoTimestamp(leftLatest)).getTime() : 0);
    }),
    [seriesGroups],
  );
  const dayKeys = useMemo(
    () => Object.keys(dayGroups).sort((left, right) => right.localeCompare(left)),
    [dayGroups],
  );

  useEffect(() => {
    if (!selectedSeries || !seriesGroups[selectedSeries]) {
      setSelectedSeries(seriesKeys[0] || "");
    }
  }, [selectedSeries, seriesGroups, seriesKeys]);

  useEffect(() => {
    if (!selectedDay || !dayGroups[selectedDay]) {
      setSelectedDay(dayKeys[0] || "");
    }
  }, [dayGroups, dayKeys, selectedDay]);

  const seriesPhotos = seriesGroups[selectedSeries] || [];
  const dayPhotos = dayGroups[selectedDay] || [];
  const visiblePhotos = mode === "series" ? seriesPhotos : dayPhotos;
  const visiblePhotoKey = visiblePhotos.map(({id}) => id).join("|");

  useEffect(() => {
    const missing = visiblePhotos.filter(
      (photo) => !Object.hasOwn(signedUrls, photo.id),
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (photo) => {
        const {data} = await supabase.storage
          .from(photo.bucket)
          .createSignedUrl(photo.objectPath, 1800);
        return [photo.id, data?.signedUrl || ""] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setSignedUrls((current) => ({...current, ...Object.fromEntries(entries)}));
    });
    return () => {
      cancelled = true;
    };
  }, [signedUrls, visiblePhotoKey, visiblePhotos]);

  useEffect(() => {
    const later = seriesPhotos.at(-1);
    const earlier = seriesPhotos.at(-2);
    setFirst((value) =>
      seriesPhotos.some((photo) => photo.id === value)
        ? value
        : earlier?.id || later?.id || "",
    );
    setSecond((value) =>
      seriesPhotos.some((photo) => photo.id === value)
        ? value
        : later?.id || "",
    );
  }, [selectedSeries, seriesPhotos]);

  const firstPhoto = seriesPhotos.find((photo) => photo.id === first);
  const secondPhoto = seriesPhotos.find((photo) => photo.id === second);

  function areaLabel(code: string | null): string {
    return code ? areaLabels[code] || code.replaceAll("_", " ") : "Unassigned area";
  }

  function seriesLabel(photo: PhotoLink): string {
    return `${areaLabel(photo.bodyAreaCode)} · ${photoViewLabel(photo.viewCode)}`;
  }

  function capturedLabel(photo: PhotoLink, includeArea = false): string {
    const captured = new Date(photoTimestamp(photo)).toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    });
    return includeArea ? `${seriesLabel(photo)} · ${captured}` : captured;
  }

  function dayLabel(day: string): string {
    return new Date(`${day}T12:00:00Z`).toLocaleDateString([], {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  function photoGallery(items: PhotoLink[], includeArea: boolean) {
    return (
      <div className="photo-history-grid">
        {items.map((photo) => (
          <figure key={photo.id}>
            {signedUrls[photo.id] ? (
              <a
                href={signedUrls[photo.id]}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open full-size ${seriesLabel(photo)} from ${capturedLabel(photo)}`}
              >
                <img
                  src={signedUrls[photo.id]}
                  alt={`${seriesLabel(photo)} captured ${capturedLabel(photo)}`}
                  loading="lazy"
                />
              </a>
            ) : Object.hasOwn(signedUrls, photo.id) ? (
              <div className="photo-loading">Private photo could not be loaded.</div>
            ) : (
              <div className="photo-loading">Loading private photo…</div>
            )}
            <figcaption>{capturedLabel(photo, includeArea)}</figcaption>
          </figure>
        ))}
      </div>
    );
  }

  return (
    <section className="page">
      <header className="page-header">
        <div><span className="eyebrow">Visual record</span><h1>Photos</h1></div>
        <p>
          Review like-for-like views over time or see the complete photographic record
          from one day. Differences in capture conditions can change appearance.
        </p>
      </header>

      <div className="segmented photo-mode" aria-label="Photo browsing mode">
        <button
          className={mode === "series" ? "active" : ""}
          onClick={() => setMode("series")}
        >
          Same view over time
        </button>
        <button
          className={mode === "day" ? "active" : ""}
          onClick={() => setMode("day")}
        >
          All photos from a day
        </button>
      </div>

      {error && <p className="status error" role="alert">{error}</p>}
      {loading ? (
        <div className="empty"><h2>Loading photos…</h2></div>
      ) : photos.length === 0 ? (
        <div className="empty">
          <h2>No skin photos yet</h2>
          <p>Photos remain private and are shown through short-lived links.</p>
        </div>
      ) : mode === "series" ? (
        <div className="stack photo-browser">
          <label className="card photo-browser-filter">
            Body area and view
            <select
              value={selectedSeries}
              onChange={(event) => setSelectedSeries(event.target.value)}
            >
              {seriesKeys.map((key) => {
                const group = seriesGroups[key];
                return (
                  <option value={key} key={key}>
                    {seriesLabel(group[0])} · {group.length} photo
                    {group.length === 1 ? "" : "s"}
                  </option>
                );
              })}
            </select>
          </label>
          <section>
            <div className="section-heading">
              <div>
                <span className="eyebrow">Chronological series</span>
                <h2>{seriesPhotos[0] ? seriesLabel(seriesPhotos[0]) : "Photo series"}</h2>
              </div>
              <span className="evidence">Oldest to newest</span>
            </div>
            {photoGallery(seriesPhotos, false)}
          </section>
          {seriesPhotos.length < 2 ? (
            <p className="evidence card">
              Add another photo with this exact area and view to compare change over time.
            </p>
          ) : (
            <details className="card photo-pair-tools">
              <summary>Optional two-photo overlay</summary>
              <div className="stack">
                <div className="form-grid">
                  <label>
                    Earlier photo
                    <select value={first} onChange={(event) => setFirst(event.target.value)}>
                      {seriesPhotos.map((photo) => (
                        <option value={photo.id} key={photo.id}>{capturedLabel(photo)}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Later photo
                    <select value={second} onChange={(event) => setSecond(event.target.value)}>
                      {seriesPhotos.map((photo) => (
                        <option value={photo.id} key={photo.id}>{capturedLabel(photo)}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="photo-grid">
                  <figure>
                    {firstPhoto && signedUrls[firstPhoto.id] && (
                      <img src={signedUrls[firstPhoto.id]} alt={`Earlier ${seriesLabel(firstPhoto)}`} />
                    )}
                    <figcaption>{firstPhoto && capturedLabel(firstPhoto)}</figcaption>
                  </figure>
                  <figure>
                    {secondPhoto && signedUrls[secondPhoto.id] && (
                      <img src={signedUrls[secondPhoto.id]} alt={`Later ${seriesLabel(secondPhoto)}`} />
                    )}
                    <figcaption>{secondPhoto && capturedLabel(secondPhoto)}</figcaption>
                  </figure>
                </div>
                <label>
                  Overlay opacity: {opacity}%
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={opacity}
                    onChange={(event) => setOpacity(Number(event.target.value))}
                  />
                </label>
                <div className="photo-overlay">
                  {firstPhoto && signedUrls[firstPhoto.id] && (
                    <img src={signedUrls[firstPhoto.id]} alt="" />
                  )}
                  {secondPhoto && signedUrls[secondPhoto.id] && (
                    <img
                      src={signedUrls[secondPhoto.id]}
                      alt=""
                      style={{opacity: opacity / 100}}
                    />
                  )}
                </div>
              </div>
            </details>
          )}
        </div>
      ) : (
        <div className="stack photo-browser">
          <label className="card photo-browser-filter">
            Date
            <select value={selectedDay} onChange={(event) => setSelectedDay(event.target.value)}>
              {dayKeys.map((day) => (
                <option value={day} key={day}>
                  {dayLabel(day)} · {dayGroups[day].length} photo
                  {dayGroups[day].length === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </label>
          <section>
            <div className="section-heading">
              <div>
                <span className="eyebrow">Daily record</span>
                <h2>{selectedDay ? dayLabel(selectedDay) : "Selected day"}</h2>
              </div>
              <span className="evidence">Earliest to latest</span>
            </div>
            {photoGallery(dayPhotos, true)}
          </section>
        </div>
      )}
    </section>
  );
}
