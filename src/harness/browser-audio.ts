/**
 * The browser's microphone and Web Audio, as the MicrophoneEnvironment the provider is given (src/audio/microphone-provider.ts). The only place that names
 * navigator.mediaDevices, isSecureContext and AudioContext — and it only hands them over: what is done with them is the provider's, and is tested on a fake.
 */
import type { AudioContextLike, MediaStreamLike, MicrophoneEnvironment } from '../audio/microphone-provider.ts';

type AudioContextConstructor = new () => AudioContext;

export function browserMicrophoneEnvironment(): MicrophoneEnvironment {
  const scope = globalThis as unknown as {
    isSecureContext?: boolean;
    navigator?: { mediaDevices?: MediaDevices };
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  const devices = scope.navigator?.mediaDevices;
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  return {
    secureContext: scope.isSecureContext === true,
    mediaDevices:
      devices !== undefined && typeof devices.getUserMedia === 'function'
        ? { getUserMedia: async (constraints) => (await devices.getUserMedia(constraints)) as unknown as MediaStreamLike }
        : undefined,
    createAudioContext:
      Context === undefined
        ? undefined
        : (): AudioContextLike => {
            const context = new Context();
            return {
              get sampleRate() {
                return context.sampleRate;
              },
              get state() {
                return context.state;
              },
              createMediaStreamSource: (stream) => {
                const source = context.createMediaStreamSource(stream as unknown as MediaStream);
                return {
                  // the analyser given is the AnalyserNode createAnalyser made: the provider connects the one to the other, and to nothing else
                  connect: (analyser) => source.connect(analyser as unknown as AnalyserNode),
                  disconnect: () => source.disconnect(),
                };
              },
              createAnalyser: () => context.createAnalyser(),
              resume: () => context.resume(),
              close: () => context.close(),
            };
          },
  };
}
