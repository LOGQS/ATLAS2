// status: complete

import logger from '../core/logger';

interface AudioRecorderConfig {
  silenceThreshold: number; 
  silenceDuration: number; 
  sampleRate: number;
  onAudioLevelUpdate?: (level: number, isSoundDetected: boolean) => void;
}

class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private audioContext: AudioContext | null = null;
  private isRecording: boolean = false;
  private config: AudioRecorderConfig;
  private silenceDetectionActive: boolean = true;
  private lastSoundTime: number = Date.now();
  private animationFrameId: number | null = null;
  private currentAudioLevel: number = 0;

  constructor(config?: Partial<AudioRecorderConfig>) {
    this.config = {
      silenceThreshold: 10,
      silenceDuration: 1000,
      sampleRate: 16000,
      ...config
    };
  }

  async startRecording(): Promise<void> {
    try {
      logger.info('[AUDIO_RECORDING] Requesting microphone access...');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: this.config.sampleRate,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      logger.info('[AUDIO_RECORDING] Microphone access granted');

      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      source.connect(this.analyser);
      this.analyser.fftSize = 256;
      logger.info('[AUDIO_RECORDING] Audio analyser configured');

      const mimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4'
      ];

      let selectedMimeType = '';
      for (const mimeType of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
          selectedMimeType = mimeType;
          break;
        }
      }

      if (!selectedMimeType) {
        logger.warn('[AUDIO_RECORDING] No supported MIME type found, using default');
        this.mediaRecorder = new MediaRecorder(this.stream);
      } else {
        logger.info('[AUDIO_RECORDING] Using MIME type:', selectedMimeType);
        this.mediaRecorder = new MediaRecorder(this.stream, {
          mimeType: selectedMimeType
        });
      }

      this.audioChunks = [];
      this.isRecording = true;
      this.lastSoundTime = Date.now();

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
          logger.info('[AUDIO_RECORDING] Audio chunk received, size:', event.data.size);
        }
      };

      this.mediaRecorder.start(100);
      logger.info('[AUDIO_RECORDING] Recording started');

      if (this.silenceDetectionActive) {
        this.monitorSilence();
        logger.info('[AUDIO_SILENCE] Silence monitoring started');
      }

    } catch (error) {
      logger.error('[AUDIO_RECORDING] Error starting recording:', error);
      throw error;
    }
  }

  private monitorSilence(): void {
    if (!this.isRecording || !this.analyser) return;

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const checkSound = () => {
      if (!this.isRecording) {
        if (this.animationFrameId) {
          cancelAnimationFrame(this.animationFrameId);
          this.animationFrameId = null;
        }
        return;
      }

      this.analyser!.getByteFrequencyData(dataArray);

      const average = dataArray.reduce((a, b) => a + b) / bufferLength;
      this.currentAudioLevel = average;

      const isSoundDetected = average > this.config.silenceThreshold;
      if (isSoundDetected) {
        this.lastSoundTime = Date.now();
        logger.info('[AUDIO_LEVEL] Sound detected, level:', average);
      }

      if (this.config.onAudioLevelUpdate) {
        this.config.onAudioLevelUpdate(average, isSoundDetected);
      }

      this.animationFrameId = requestAnimationFrame(checkSound);
    };

    checkSound();
  }

  async stopRecording(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder || !this.isRecording) {
        reject(new Error('No recording in progress'));
        return;
      }

      this.isRecording = false;

      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }

      this.mediaRecorder.onstop = async () => {
        try {
          logger.info('[AUDIO_RECORDING] MediaRecorder stopped, processing chunks...');

          if (this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
            logger.info('[AUDIO_RECORDING] Audio context closed');
          }

          if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
            logger.info('[AUDIO_RECORDING] Media stream tracks stopped');
          }

          const audioBlob = await this.processAudioChunks();
          logger.info('[AUDIO_RECORDING] Audio processing complete, blob size:', audioBlob.size);
          resolve(audioBlob);
        } catch (error) {
          logger.error('[AUDIO_RECORDING] Error in onstop handler:', error);
          reject(error);
        }
      };

      this.mediaRecorder.stop();
    });
  }

  private async processAudioChunks(): Promise<Blob> {
    logger.info('[AUDIO_PROCESS] Processing', this.audioChunks.length, 'audio chunks');

    const webmBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
    logger.info('[AUDIO_PROCESS] Created WebM blob, size:', webmBlob.size);

    const wavBlob = await this.convertToWav(webmBlob);
    logger.info('[AUDIO_PROCESS] Converted to WAV, size:', wavBlob.size);

    return wavBlob;
  }

  private async convertToWav(blob: Blob): Promise<Blob> {
    logger.info('[AUDIO_CONVERT] Starting WebM to WAV conversion');
    const audioContext = new AudioContext();
    const arrayBuffer = await blob.arrayBuffer();

    try {
      logger.info('[AUDIO_CONVERT] Decoding audio data...');
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      logger.info('[AUDIO_CONVERT] Audio decoded - channels:', audioBuffer.numberOfChannels,
                  'sampleRate:', audioBuffer.sampleRate, 'duration:', audioBuffer.duration);

      const wavBlob = this.audioBufferToWav(audioBuffer);
      logger.info('[AUDIO_CONVERT] WAV conversion complete, size:', wavBlob.size);

      await audioContext.close();
      return wavBlob;
    } catch (error) {
      logger.error('[AUDIO_CONVERT] Error converting audio:', error);
      await audioContext.close();

      logger.warn('[AUDIO_CONVERT] Returning original blob due to conversion error');
      return blob;
    }
  }

  private audioBufferToWav(buffer: AudioBuffer): Blob {
    const numberOfChannels = buffer.numberOfChannels;
    const length = buffer.length * numberOfChannels * 2;
    const arrayBuffer = new ArrayBuffer(44 + length);
    const view = new DataView(arrayBuffer);
    const channels: Float32Array[] = [];
    let offset = 0;
    let pos = 0;

    const setUint16 = (data: number) => {
      view.setUint16(pos, data, true);
      pos += 2;
    };

    const setUint32 = (data: number) => {
      view.setUint32(pos, data, true);
      pos += 4;
    };

    setUint32(0x46464952); 
    setUint32(36 + length); 
    setUint32(0x45564157);

    setUint32(0x20746d66); 
    setUint32(16); 
    setUint16(1); 
    setUint16(numberOfChannels);
    setUint32(buffer.sampleRate);
    setUint32(buffer.sampleRate * 2 * numberOfChannels); 
    setUint16(numberOfChannels * 2); 
    setUint16(16); 

    setUint32(0x61746164); 
    setUint32(length);

    for (let i = 0; i < buffer.numberOfChannels; i++) {
      channels.push(buffer.getChannelData(i));
    }

    offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const sample = Math.max(-1, Math.min(1, channels[channel][i]));
        view.setInt16(offset, sample * 0x7FFF, true);
        offset += 2;
      }
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  isCurrentlyRecording(): boolean {
    return this.isRecording;
  }

  getTimeSinceLastSound(): number {
    return Date.now() - this.lastSoundTime;
  }

  getCurrentAudioLevel(): number {
    return this.currentAudioLevel;
  }
}

export default AudioRecorder;
export type { AudioRecorderConfig };