import {describe, expect, it} from "vitest";
import {
  buildVoiceTranscriptionProvenance,
  moonshineConfig,
} from "./voiceTranscription";

describe("voice transcription provenance", () => {
  it("records an on-device transcript and user correction", () => {
    const provenance = buildVoiceTranscriptionProvenance({
      machineTranscript: "I used tomato",
      confirmedText: "I handled raw tomato",
      confirmedAt: "2026-07-29T12:00:00.000Z",
      fallbackRequested: false,
      localError: null,
    });

    expect(provenance).toMatchObject({
      provider: "moonshine-js",
      package_version: moonshineConfig.packageVersion,
      processing_location: "user_device",
      machine_transcript: "I used tomato",
      transcript_status: "user_confirmed",
      user_correction_applied: true,
      confidence_available: false,
    });
  });

  it("marks backend transcription as an explicit fallback", () => {
    const provenance = buildVoiceTranscriptionProvenance({
      machineTranscript: null,
      confirmedText: "",
      confirmedAt: null,
      fallbackRequested: true,
      localError: "Model download failed",
    });

    expect(provenance).toMatchObject({
      provider: "backend_fallback",
      processing_location: "configured_backend",
      transcript_status: "fallback_requested",
      local_error: "Model download failed",
    });
  });
});
