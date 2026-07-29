const sampleRate = 16_000;

export const moonshineConfig = {
  provider: "moonshine-js",
  packageVersion: "0.1.29",
  model: "model/tiny",
  precision: "quantized",
  language: "en",
} as const;

let modelPromise: Promise<{
  generate(audio: Float32Array): Promise<string>;
}> | null = null;

async function loadModel() {
  if (!modelPromise) {
    modelPromise = import("@moonshine-ai/moonshine-js").then(async ({MoonshineModel}) => {
      const model = new MoonshineModel(moonshineConfig.model, moonshineConfig.precision);
      await model.loadModel();
      return model;
    }).catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

async function decodeToMono16k(file: File): Promise<Float32Array> {
  const audioContext = new AudioContext();
  try {
    const sourceBuffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    const frameCount = Math.max(1, Math.ceil(sourceBuffer.duration * sampleRate));
    const offlineContext = new OfflineAudioContext(1, frameCount, sampleRate);
    const source = offlineContext.createBufferSource();
    source.buffer = sourceBuffer;
    source.connect(offlineContext.destination);
    source.start();
    const rendered = await offlineContext.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    await audioContext.close();
  }
}

export async function transcribeWithMoonshine(file: File): Promise<string> {
  const [model, audio] = await Promise.all([loadModel(), decodeToMono16k(file)]);
  const transcript = await model.generate(audio);
  const normalized = transcript?.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Moonshine did not detect any speech.");
  return normalized;
}

export function buildVoiceTranscriptionProvenance({
  machineTranscript,
  confirmedText,
  confirmedAt,
  fallbackRequested,
  localError,
}: {
  machineTranscript: string | null;
  confirmedText: string;
  confirmedAt: string | null;
  fallbackRequested: boolean;
  localError: string | null;
}) {
  const normalizedMachine = machineTranscript?.replace(/\s+/g, " ").trim() || null;
  const normalizedConfirmed = confirmedText.replace(/\s+/g, " ").trim();
  return {
    provider: fallbackRequested
      ? "backend_fallback"
      : normalizedMachine
        ? moonshineConfig.provider
        : "manual",
    package_version: moonshineConfig.packageVersion,
    model: moonshineConfig.model,
    precision: moonshineConfig.precision,
    language: moonshineConfig.language,
    processing_location: fallbackRequested
      ? "configured_backend"
      : normalizedMachine
        ? "user_device"
        : "manual_entry",
    confidence: null,
    confidence_available: false,
    machine_transcript: normalizedMachine,
    transcript_status: fallbackRequested
      ? "fallback_requested"
      : normalizedMachine
        ? "user_confirmed"
        : "user_supplied_after_local_failure",
    user_confirmed_at: confirmedAt,
    user_correction_applied: normalizedMachine !== null && normalizedMachine !== normalizedConfirmed,
    local_error: localError,
  };
}
