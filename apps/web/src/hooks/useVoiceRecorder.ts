import {useRef, useState} from "react";

const maxRecordingSeconds = 30;

export function useVoiceRecorder() {
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef<number | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopResolver = useRef<((file: File | null) => void) | null>(null);
  const [recording, setRecording] = useState(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);

  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true});
    const mediaRecorder = new MediaRecorder(stream);
    chunks.current = [];
    setAudioFile(null);
    setDurationSeconds(null);
    startedAt.current = performance.now();
    mediaRecorder.ondataavailable = (event) => chunks.current.push(event.data);
    mediaRecorder.onstop = () => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
      const type = mediaRecorder.mimeType || "audio/webm";
      const extension = type.includes("mp4")
        ? "m4a"
        : type.includes("mpeg")
          ? "mp3"
          : type.includes("ogg")
            ? "ogg"
            : "webm";
      const blob = new Blob(chunks.current, {type});
      const nextAudioFile = new File([blob], `voice-${Date.now()}.${extension}`, {type});
      setAudioFile(nextAudioFile);
      setDurationSeconds(
        startedAt.current === null
          ? null
          : Math.min(maxRecordingSeconds, (performance.now() - startedAt.current) / 1000),
      );
      startedAt.current = null;
      stream.getTracks().forEach((track) => track.stop());
      recorder.current = null;
      setRecording(false);
      stopResolver.current?.(nextAudioFile);
      stopResolver.current = null;
    };
    mediaRecorder.start();
    recorder.current = mediaRecorder;
    setRecording(true);
    stopTimer.current = setTimeout(() => {
      if (mediaRecorder.state === "recording") mediaRecorder.stop();
    }, maxRecordingSeconds * 1000);
  }

  function stop(): Promise<File | null> {
    if (recorder.current?.state !== "recording") return Promise.resolve(audioFile);
    return new Promise((resolve) => {
      stopResolver.current = resolve;
      recorder.current?.stop();
    });
  }

  function clear() {
    setAudioFile(null);
    setDurationSeconds(null);
  }

  return {
    recording,
    audioFile,
    durationSeconds,
    maxRecordingSeconds,
    start,
    stop,
    clear,
  };
}
