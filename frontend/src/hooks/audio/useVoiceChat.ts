import { useState, useRef, useCallback, useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import AudioRecorder from '../../utils/audio/audioRecorder';
import logger from '../../utils/core/logger';
import { apiUrl } from '../../config/api';

const AUTO_SILENCE_TIMEOUT_MS = 2500;
const AUTO_MIN_SEGMENT_SIZE_BYTES = 1024;
const AUTO_SILENCE_THRESHOLD = 15;
const MIN_SPEECH_DURATION_MS = 500;

interface UseVoiceChatProps {
  onTranscriptionComplete?: (text: string, context: { source: 'manual' | 'auto' }) => void;
  holdDetectionMs?: number;
  onSpeechStart?: () => void;
  silenceDurationMs?: number;
  onSegmentProcessing?: (processing: boolean) => void;
  isAwaitingResponse?: () => boolean;
}

interface UseVoiceChatReturn {
  isButtonHeld: boolean;
  wasHoldCompleted: boolean;
  isRecording: boolean;
  isSoundDetected: boolean;
  isVoiceChatMode: boolean;
  isMicMuted: boolean;

  handleButtonHoldStart: () => void;
  handleButtonHoldEnd: () => void;
  toggleVoiceChatMode: () => void;
  setVoiceChatMode: Dispatch<SetStateAction<boolean>>;
  toggleMicMute: () => void;
  setMicMuted: Dispatch<SetStateAction<boolean>>;
  restartListeningIfNeeded: () => void;
}

export const useVoiceChat = ({
  onTranscriptionComplete,
  onSpeechStart,
  holdDetectionMs = 700,
  silenceDurationMs = AUTO_SILENCE_TIMEOUT_MS,
  onSegmentProcessing,
  isAwaitingResponse
}: UseVoiceChatProps = {}): UseVoiceChatReturn => {
  const [isButtonHeld, setIsButtonHeld] = useState(false);
  const [wasHoldCompleted, setWasHoldCompleted] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSoundDetected, setIsSoundDetected] = useState(false);
  const [isVoiceChatMode, setIsVoiceChatMode] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);

  const holdTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const manualRecorderRef = useRef<AudioRecorder | null>(null);

  const autoRecorderRef = useRef<AudioRecorder | null>(null);
  const autoRecorderBusyRef = useRef(false);
  const autoSessionActiveRef = useRef(false);
  const autoSegmentActiveRef = useRef(false);
  const silenceTimeoutRef = useRef<number | null>(null);
  const silenceDurationRef = useRef(silenceDurationMs);
  const isVoiceChatModeRef = useRef(isVoiceChatMode);
  const isMicMutedRef = useRef(isMicMuted);
  const speechStartTimeRef = useRef<number | null>(null);

  const finalizeAutoSegmentRef = useRef<((reason: 'silence' | 'max_duration' | 'manual') => void) | undefined>(undefined);
  const startAutoRecorderRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    silenceDurationRef.current = silenceDurationMs;
  }, [silenceDurationMs]);

  useEffect(() => {
    isVoiceChatModeRef.current = isVoiceChatMode;
  }, [isVoiceChatMode]);

  useEffect(() => {
    isMicMutedRef.current = isMicMuted;
  }, [isMicMuted]);

  const setMicMutedState: Dispatch<SetStateAction<boolean>> = useCallback((value) => {
    setIsMicMuted(prev => {
      const next = typeof value === 'function'
        ? (value as (prevState: boolean) => boolean)(prev)
        : value;

      if (next !== prev) {
        logger.info(`[VOICE_CHAT] Mic mute state updated: ${next}`);
      }
      return next;
    });
  }, []);

  const toggleMicMute = useCallback(() => {
    setMicMutedState(prev => !prev);
  }, [setMicMutedState]);

  useEffect(() => {
    return () => {
      if (manualRecorderRef.current && manualRecorderRef.current.isCurrentlyRecording()) {
        manualRecorderRef.current.stopRecording().catch(error => {
          logger.error('[AUDIO_RECORDING] Error stopping recording on unmount:', error);
        });
      }
    };
  }, []);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
      silenceTimeoutRef.current = null;
    }
  }, []);

  const sendAudioForTranscription = useCallback(async (audioBlob: Blob) => {
    try {
      if (!audioBlob.type || !audioBlob.type.toLowerCase().includes('wav')) {
        logger.warn('[STT_TRANSCRIBE] Dropping segment with unsupported MIME type', { mimeType: audioBlob.type, size: audioBlob.size });
        return;
      }

      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.wav');
      logger.info('[STT_TRANSCRIBE] Sending auto voice audio to backend...');
      const response = await fetch(apiUrl('/api/stt/transcribe'), {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('[STT_TRANSCRIBE] Auto voice transcription failed:', {
          status: response.status,
          error: errorText
        });
        return;
      }

      const result = await response.json();
      logger.info('[STT_TRANSCRIBE] Auto voice transcription response:', result);

      if (result.success && result.text) {
        onTranscriptionComplete?.(result.text as string, { source: 'auto' });
      } else {
        logger.warn('[STT_TRANSCRIBE] Auto voice transcription returned no text');
      }
    } catch (error) {
      logger.error('[STT_TRANSCRIBE] Auto voice transcription error:', error);
    }
  }, [onTranscriptionComplete]);

  const finalizeAutoSegment = useCallback(async (reason: 'silence' | 'max_duration' | 'manual') => {
    if (autoRecorderBusyRef.current) {
      logger.debug('[VOICE_CHAT] finalizeAutoSegment skipped - recorder busy');
      return;
    }

    const recorder = autoRecorderRef.current;
    if (!recorder) {
      return;
    }

    if (!recorder.isCurrentlyRecording()) {
      autoRecorderRef.current = null;
      return;
    }

    onSegmentProcessing?.(true);
    autoRecorderBusyRef.current = true;
    autoRecorderRef.current = null;

    clearSilenceTimer();

    const hadActiveSegment = autoSegmentActiveRef.current;
    const speechDuration = speechStartTimeRef.current ? Date.now() - speechStartTimeRef.current : 0;
    autoSegmentActiveRef.current = false;
    speechStartTimeRef.current = null;
    setIsRecording(false);
    setIsSoundDetected(false);

    try {
      const audioBlob = await recorder.stopRecording();

      const shouldSend = reason !== 'manual'
        && audioBlob.size >= AUTO_MIN_SEGMENT_SIZE_BYTES
        && (hadActiveSegment || reason === 'max_duration')
        && speechDuration >= MIN_SPEECH_DURATION_MS;

      if (isMicMutedRef.current) {
        logger.info('[VOICE_CHAT] Dropped auto segment while microphone muted', {
          reason,
          size: audioBlob.size,
          hadActiveSegment,
          speechDuration
        });
      } else if (shouldSend) {
        await sendAudioForTranscription(audioBlob);
      } else {
        logger.debug('[VOICE_CHAT] Dropped auto segment', {
          reason,
          size: audioBlob.size,
          hadActiveSegment,
          speechDuration,
          minRequired: MIN_SPEECH_DURATION_MS
        });
      }
    } catch (error) {
      logger.error('[VOICE_CHAT] Failed to finalize auto voice segment:', error);
    } finally {
      autoRecorderBusyRef.current = false;
      onSegmentProcessing?.(false);

      if (isVoiceChatModeRef.current && autoSessionActiveRef.current && !isAwaitingResponse?.()) {
        startAutoRecorderRef.current?.();
      }
    }
  }, [clearSilenceTimer, sendAudioForTranscription, onSegmentProcessing, isAwaitingResponse]);

  useEffect(() => {
    finalizeAutoSegmentRef.current = (reason) => {
      void finalizeAutoSegment(reason);
    };
    return () => {
      finalizeAutoSegmentRef.current = undefined;
    };
  }, [finalizeAutoSegment]);

  const handleAutoAudioLevel = useCallback((_level: number, soundDetected: boolean) => {
    if (!autoSessionActiveRef.current || !isVoiceChatModeRef.current || autoRecorderBusyRef.current) {
      return;
    }

    if (isMicMutedRef.current) {
      if (autoSegmentActiveRef.current) {
        autoSegmentActiveRef.current = false;
        clearSilenceTimer();
      }
      setIsSoundDetected(false);
      setIsRecording(false);
      return;
    }
    setIsSoundDetected(soundDetected);

    if (soundDetected) {
      if (!autoSegmentActiveRef.current) {
        autoSegmentActiveRef.current = true;
        speechStartTimeRef.current = Date.now();
        autoRecorderRef.current?.clearAudioBuffer();
        onSpeechStart?.();
      }
      clearSilenceTimer();
    } else if (autoSegmentActiveRef.current && !silenceTimeoutRef.current) {
      silenceTimeoutRef.current = window.setTimeout(() => {
        finalizeAutoSegmentRef.current?.('silence');
      }, silenceDurationRef.current);
    }

    setIsRecording(autoSegmentActiveRef.current);
  }, [clearSilenceTimer, onSpeechStart]);

  const startAutoRecorder = useCallback(async () => {
    if (!autoSessionActiveRef.current || !isVoiceChatModeRef.current) {
      return;
    }

    if (autoRecorderBusyRef.current) {
      return;
    }

    if (autoRecorderRef.current && autoRecorderRef.current.isCurrentlyRecording()) {
      return;
    }

    if (isMicMutedRef.current) {
      logger.debug('[VOICE_CHAT] Not starting auto recorder while microphone muted');
      return;
    }

    if (isAwaitingResponse?.()) {
      logger.debug('[VOICE_CHAT] Not starting auto recorder while awaiting AI response');
      return;
    }

    autoRecorderBusyRef.current = true;
    autoSegmentActiveRef.current = false;
    setIsRecording(false);
    setIsSoundDetected(false);

    const recorder = new AudioRecorder({
      silenceThreshold: AUTO_SILENCE_THRESHOLD,
      onAudioLevelUpdate: handleAutoAudioLevel,
      onMaxDurationReached: () => {
        finalizeAutoSegmentRef.current?.('max_duration');
      }
    });

    autoRecorderRef.current = recorder;

    try {
      await recorder.startRecording();
      logger.info('[VOICE_CHAT] Auto voice recorder started');
    } catch (error) {
      logger.error('[VOICE_CHAT] Failed to start auto voice recorder:', error);
      autoRecorderRef.current = null;
    } finally {
      autoRecorderBusyRef.current = false;

      if (!autoSessionActiveRef.current || !isVoiceChatModeRef.current) {
        const activeRecorder = autoRecorderRef.current;
        autoRecorderRef.current = null;
        if (activeRecorder && activeRecorder.isCurrentlyRecording()) {
          activeRecorder.stopRecording().catch(err => {
            logger.error('[VOICE_CHAT] Error stopping auto recorder during shutdown:', err);
          });
        }
      }
    }
  }, [handleAutoAudioLevel, isAwaitingResponse]);

  useEffect(() => {
    startAutoRecorderRef.current = () => {
      void startAutoRecorder();
    };
    return () => {
      startAutoRecorderRef.current = undefined;
    };
  }, [startAutoRecorder]);

  const startVoiceChatSession = useCallback(() => {
    if (autoSessionActiveRef.current) {
      return;
    }

    if (isMicMuted) {
      logger.info('[VOICE_CHAT] Skipping live voice chat session start - microphone muted');
      return;
    }

    autoSessionActiveRef.current = true;
    autoSegmentActiveRef.current = false;
    setIsRecording(false);
    setIsSoundDetected(false);
    startAutoRecorderRef.current?.();
    logger.info('[VOICE_CHAT] Live voice chat session started');
  }, [isMicMuted]);

  const restartListeningIfNeeded = useCallback(() => {
    if (!autoSessionActiveRef.current || !isVoiceChatModeRef.current) {
      return;
    }

    if (isMicMutedRef.current) {
      return;
    }

    if (autoRecorderRef.current && autoRecorderRef.current.isCurrentlyRecording()) {
      return;
    }

    if (!isAwaitingResponse?.()) {
      logger.info('[VOICE_CHAT] Restarting listening after AI response started');
      startAutoRecorderRef.current?.();
    }
  }, [isAwaitingResponse]);

  const stopVoiceChatSession = useCallback(async () => {
    if (!autoSessionActiveRef.current && !autoRecorderRef.current) {
      return;
    }

    autoSessionActiveRef.current = false;
    clearSilenceTimer();
    autoSegmentActiveRef.current = false;
    setIsRecording(false);
    setIsSoundDetected(false);

    const recorder = autoRecorderRef.current;
    autoRecorderRef.current = null;

    if (recorder && recorder.isCurrentlyRecording()) {
      try {
        await recorder.stopRecording();
      } catch (error) {
        logger.error('[VOICE_CHAT] Error stopping auto voice recorder:', error);
      }
    }

    logger.info('[VOICE_CHAT] Live voice chat session stopped');
  }, [clearSilenceTimer]);

  useEffect(() => {
    if (isVoiceChatMode && !isMicMuted) {
      startVoiceChatSession();
    } else {
      if (isVoiceChatMode && isMicMuted) {
        logger.info('[VOICE_CHAT] Voice chat active with microphone muted - auto detection paused');
      }
      void stopVoiceChatSession();
    }
  }, [isVoiceChatMode, isMicMuted, startVoiceChatSession, stopVoiceChatSession]);

  useEffect(() => {
    return () => {
      void stopVoiceChatSession();
    };
  }, [stopVoiceChatSession]);

  const handleButtonHoldEnd = useCallback(async () => {
    if (isVoiceChatModeRef.current) {
      logger.info('[VOICE_CHAT] Ignoring hold end while live voice chat mode active');
      return;
    }

    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }

    if (isButtonHeld) {
      setIsButtonHeld(false);
      logger.debug('[HOLD_DETECTION] Send button hold released - stopping animation');

      setTimeout(() => {
        setWasHoldCompleted(false);
      }, 100);

      if (isRecording && manualRecorderRef.current) {
        try {
          logger.info('[AUDIO_RECORDING] Stopping recording...');
          const audioBlob = await manualRecorderRef.current.stopRecording();
          setIsRecording(false);
          setIsSoundDetected(false);
          logger.info('[AUDIO_RECORDING] Recording stopped, blob size:', audioBlob.size, 'type:', audioBlob.type);

          if (!audioBlob.type || !audioBlob.type.toLowerCase().includes('wav')) {
            logger.warn('[STT_TRANSCRIBE] Discarding manual recording due to unsupported MIME type', { mimeType: audioBlob.type, size: audioBlob.size });
            return;
          }

          const formData = new FormData();
          formData.append('audio', audioBlob, 'recording.wav');
          logger.info('[STT_TRANSCRIBE] Sending audio to backend for transcription...');

          const response = await fetch(apiUrl('/api/stt/transcribe'), {
            method: 'POST',
            body: formData
          });

          if (response.ok) {
            const result = await response.json();
            logger.info('[STT_TRANSCRIBE] Transcription response:', result);

            if (result.success && result.text) {
              onTranscriptionComplete?.(result.text, { source: 'manual' });
              logger.info('[STT_TRANSCRIBE] Transcription successful, text:', result.text);
            } else {
              logger.warn('[STT_TRANSCRIBE] Transcription returned but no text:', result);
            }
          } else {
            const errorText = await response.text();
            logger.error('[STT_TRANSCRIBE] Failed to transcribe audio, status:', response.status, 'error:', errorText);
          }
        } catch (error) {
          logger.error('[AUDIO_RECORDING] Error processing recording:', error);
        }
      }
    }
  }, [isButtonHeld, isRecording, onTranscriptionComplete]);

  const handleButtonHoldStart = useCallback(() => {
    if (isVoiceChatModeRef.current) {
      logger.info('[VOICE_CHAT] Ignoring hold start while live voice chat mode active');
      return;
    }

    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
    }

    setWasHoldCompleted(false);

    holdTimeoutRef.current = setTimeout(async () => {
      setIsButtonHeld(true);
      setWasHoldCompleted(true);
      logger.debug('[HOLD_DETECTION] Send button hold detected - starting animation and recording');

      try {
        if (!manualRecorderRef.current) {
          manualRecorderRef.current = new AudioRecorder({
            onAudioLevelUpdate: (_level: number, soundDetected: boolean) => {
              setIsSoundDetected(soundDetected);
            },
            onMaxDurationReached: () => {
              logger.warn('[AUDIO_RECORDING] Maximum recording duration (1 hour) reached');
              void handleButtonHoldEnd();
            }
          });
        }
        await manualRecorderRef.current.startRecording();
        setIsRecording(true);
        setIsSoundDetected(false);
        logger.info('[AUDIO_RECORDING] Recording session started successfully');
      } catch (error) {
        logger.error('[AUDIO_RECORDING] Failed to start recording:', error);
      }
    }, holdDetectionMs);
  }, [handleButtonHoldEnd, holdDetectionMs]);

  const toggleVoiceChatMode = useCallback(() => {
    setIsVoiceChatMode(prev => {
      const newMode = !prev;
      logger.info(`[VOICE_CHAT] Voice chat mode toggled: ${newMode}`);
      return newMode;
    });
  }, []);

  return {
    isButtonHeld,
    wasHoldCompleted,
    isRecording,
    isSoundDetected,
    isVoiceChatMode,
    isMicMuted,

    handleButtonHoldStart,
    handleButtonHoldEnd,
    toggleVoiceChatMode,
    setVoiceChatMode: setIsVoiceChatMode,
    toggleMicMute,
    setMicMuted: setMicMutedState,
    restartListeningIfNeeded
  };
};