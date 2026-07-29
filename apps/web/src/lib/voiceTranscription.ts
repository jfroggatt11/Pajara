export const moonshineConfig = {
  provider: "moonshine-js",
  packageVersion: "0.1.29",
  model: "model/tiny",
  precision: "quantized",
  language: "en",
} as const;

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
