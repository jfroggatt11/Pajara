import {useRef, useState} from "react";

export function useVoiceRecorder() {
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);

  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true});
    const mediaRecorder = new MediaRecorder(stream);
    chunks.current = [];
    mediaRecorder.ondataavailable = (event) => chunks.current.push(event.data);
    mediaRecorder.onstop = () => {
      const type = mediaRecorder.mimeType || "audio/webm";
      const extension = type.includes("mp4")
        ? "m4a"
        : type.includes("mpeg")
          ? "mp3"
          : type.includes("ogg")
            ? "ogg"
            : "webm";
      const blob = new Blob(chunks.current, {type});
      setAudioFile(new File([blob], `voice-${Date.now()}.${extension}`, {type}));
      stream.getTracks().forEach((track) => track.stop());
    };
    mediaRecorder.start();
    recorder.current = mediaRecorder;
    setRecording(true);
  }

  function stop() {
    recorder.current?.stop();
    setRecording(false);
  }

  function clear() {
    setAudioFile(null);
  }

  return {recording, audioFile, start, stop, clear};
}
