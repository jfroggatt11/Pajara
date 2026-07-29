declare module "@moonshine-ai/moonshine-js" {
  export class MoonshineModel {
    constructor(modelURL: string, precision?: string);
    loadModel(): Promise<void>;
    generate(audio: Float32Array): Promise<string>;
  }
}
