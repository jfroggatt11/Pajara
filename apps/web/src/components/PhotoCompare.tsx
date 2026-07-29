import {useEffect, useMemo, useState} from "react";
import {supabase} from "../lib/supabase";

interface PhotoLink {
  id: string;
  body_area_code: string | null;
  view_code: string | null;
  artifacts: {
    bucket: string;
    object_path: string;
    captured_at: string | null;
  };
  signedUrl?: string;
}

export function PhotoCompare({refreshKey}: {refreshKey: number}) {
  const [photos, setPhotos] = useState<PhotoLink[]>([]);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [opacity, setOpacity] = useState(50);

  useEffect(() => {
    void supabase
      .from("record_artifacts")
      .select("id,body_area_code,view_code,artifacts!inner(bucket,object_path,captured_at)")
      .eq("role", "skin_photo")
      .order("created_at", {ascending: false})
      .limit(50)
      .then(async ({data}) => {
        const rows = (data || []) as unknown as PhotoLink[];
        const signed = await Promise.all(
          rows.map(async (row) => {
            const {data: urlData} = await supabase.storage
              .from(row.artifacts.bucket)
              .createSignedUrl(row.artifacts.object_path, 600);
            return {...row, signedUrl: urlData?.signedUrl};
          }),
        );
        setPhotos(signed);
        const later = signed[0];
        const matchingEarlier = later
          ? signed.find((photo) =>
              photo.id !== later.id
              && photo.body_area_code === later.body_area_code
              && photo.view_code === later.view_code
            )
          : undefined;
        setFirst((value) =>
          signed.some((photo) => photo.id === value)
            ? value
            : matchingEarlier?.id || signed[1]?.id || later?.id || ""
        );
        setSecond((value) =>
          signed.some((photo) => photo.id === value) ? value : later?.id || ""
        );
      });
  }, [refreshKey]);

  const firstPhoto = useMemo(() => photos.find((photo) => photo.id === first), [first, photos]);
  const secondPhoto = useMemo(() => photos.find((photo) => photo.id === second), [second, photos]);

  const optionLabel = (photo: PhotoLink) =>
    `${photo.body_area_code?.replaceAll("_", " ") || "Unassigned"} · ${
      photo.view_code?.replaceAll("_", " ") || "unspecified view"
    } · ${
      photo.artifacts.captured_at
        ? new Date(photo.artifacts.captured_at).toLocaleString()
        : "Unknown time"
    }`;

  return (
    <section className="page">
      <header className="page-header">
        <div><span className="eyebrow">Visual record</span><h1>Compare photos</h1></div>
        <p>Lighting, angle, distance, and camera differences can make changes look larger or smaller.</p>
      </header>
      {photos.length < 2 ? (
        <div className="empty"><h2>Add at least two photos</h2><p>Photos remain private and are shown through short-lived links.</p></div>
      ) : (
        <div className="stack">
          <div className="card form-grid">
            <label>Earlier photo<select value={first} onChange={(event) => setFirst(event.target.value)}>{photos.map((photo) => <option value={photo.id} key={photo.id}>{optionLabel(photo)}</option>)}</select></label>
            <label>Later photo<select value={second} onChange={(event) => setSecond(event.target.value)}>{photos.map((photo) => <option value={photo.id} key={photo.id}>{optionLabel(photo)}</option>)}</select></label>
          </div>
          <div className="photo-grid">
            <figure>{firstPhoto?.signedUrl && <img src={firstPhoto.signedUrl} alt={`Earlier ${firstPhoto.body_area_code?.replaceAll("_", " ") || "skin"} observation`} />}<figcaption>{firstPhoto && optionLabel(firstPhoto)}</figcaption></figure>
            <figure>{secondPhoto?.signedUrl && <img src={secondPhoto.signedUrl} alt={`Later ${secondPhoto.body_area_code?.replaceAll("_", " ") || "skin"} observation`} />}<figcaption>{secondPhoto && optionLabel(secondPhoto)}</figcaption></figure>
          </div>
          <div className="card">
            <label>Overlay opacity: {opacity}%<input type="range" min="0" max="100" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} /></label>
            <div className="photo-overlay">
              {firstPhoto?.signedUrl && <img src={firstPhoto.signedUrl} alt="" />}
              {secondPhoto?.signedUrl && <img src={secondPhoto.signedUrl} alt="" style={{opacity: opacity / 100}} />}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
