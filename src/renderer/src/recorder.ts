// INTENTIONAL-UNTESTED: thin glue around getUserMedia/MediaRecorder (no DOM test dependency); pinned
// end to end by the in-app selftest (permission granted by main, a recording reaches the tile).
//
// Microphone recording for voice input. The first start asks Windows/Chromium for the microphone
// (main allows exactly that: audio, this page). The audio leaves as webm/opus bytes for main.

export type Recorder = {
  /** Asks for the microphone on first use; rejects when it is denied or missing. */
  start(onLevel: (level: number) => void): Promise<void>
  /** The recording so far; releases the microphone. */
  stop(): Promise<Uint8Array>
  cancel(): void
}

export function createRecorder(): Recorder {
  let stream: MediaStream | null = null
  let rec: MediaRecorder | null = null
  let chunks: Blob[] = []
  let audio: AudioContext | null = null
  let raf = 0

  const release = () => {
    cancelAnimationFrame(raf)
    stream?.getTracks().forEach((t) => t.stop())
    void audio?.close()
    stream = null
    rec = null
    audio = null
  }

  return {
    async start(onLevel) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      chunks = []
      rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      rec.start(250)
      // a live level so the user sees the microphone hears them
      audio = new AudioContext()
      const analyser = audio.createAnalyser()
      analyser.fftSize = 512
      audio.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      const loop = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (const v of data) sum += ((v - 128) / 128) ** 2
        onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4))
        raf = requestAnimationFrame(loop)
      }
      loop()
    },
    stop() {
      const r = rec
      if (!r) return Promise.resolve(new Uint8Array())
      return new Promise((resolve) => {
        r.onstop = async () => {
          const bytes = new Uint8Array(await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer())
          release()
          resolve(bytes)
        }
        r.stop()
      })
    },
    cancel() {
      rec?.stop()
      release()
    }
  }
}
